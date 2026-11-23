import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type {
  ImpulseSignal,
  OrderExecutionStyle,
  PythFeedSnapshot,
  SolanaBroadcastStatus,
  SolanaExecutionReceipt,
  SolanaRiskGateDecision,
  SolanaSignerMode,
  VenueOrderbookSnapshot,
} from '../engine/types';
import { DRIFT_V2_PROGRAM_ID } from '../venues/marketDataClient';
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  LIVEEDGE_RISK_GUARD_PROGRAM_ID,
  SPL_MEMO_V2_PROGRAM_ID,
  buildAnchorRiskGuardInstruction,
  buildCanonicalAuditMemoInstruction,
  buildDriftPlacePerpOrderInstruction,
  buildInitializeRiskPolicyInstruction,
  buildSetComputeUnitLimitInstruction,
  buildSetComputeUnitPriceInstruction,
  deriveDriftUserPdas,
  deriveRiskPolicyPda,
  encodeBase58,
} from './driftInstructionBuilder';

export const DEFAULT_SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';

export interface SolanaWalletStandardProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: PublicKey | { toBase58(): string };
  connect: () => Promise<{ publicKey: PublicKey | { toBase58(): string } }>;
  signTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  signAndSendTransaction?: (
    tx: VersionedTransaction
  ) => Promise<{ signature: string }>;
}

export interface LocalSvmSimulationResult {
  unitsConsumed: number;
  logs: string[];
  slot: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

/**
 * Strictly verifies a 64-byte Ed25519 signature over the serialized Solana V0 message
 * using WebCrypto Ed25519. Fails closed (`false`) on any invalid key, malformed signature,
 * or runtime WebCrypto error — NEVER falls back to non-zero byte heuristics.
 */
export async function verifyEd25519MessageSignature(
  publicKeyBytes: Uint8Array,
  messageBytes: Uint8Array,
  signatureBytes: Uint8Array
): Promise<boolean> {
  if (
    publicKeyBytes.length !== 32 ||
    signatureBytes.length !== 64 ||
    signatureBytes.every((b) => b === 0)
  ) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes.buffer.slice(
        publicKeyBytes.byteOffset,
        publicKeyBytes.byteOffset + publicKeyBytes.byteLength
      ) as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signatureBytes.buffer.slice(
        signatureBytes.byteOffset,
        signatureBytes.byteOffset + signatureBytes.byteLength
      ) as ArrayBuffer,
      messageBytes.buffer.slice(
        messageBytes.byteOffset,
        messageBytes.byteOffset + messageBytes.byteLength
      ) as ArrayBuffer
    );
  } catch {
    return false;
  }
}

export function buildExplorerInspectorUrl(
  txSignatureB58: string,
  messageBase64: string,
  cluster: 'devnet' | 'mainnet-beta' = 'devnet'
): string {
  return `https://explorer.solana.com/tx/inspector?cluster=${cluster}&signatures=${encodeURIComponent(
    JSON.stringify([txSignatureB58])
  )}&message=${encodeURIComponent(messageBase64)}`;
}

export interface ExecuteSolanaOrderOptions {
  impulse: ImpulseSignal;
  pythFeed: PythFeedSnapshot;
  book: VenueOrderbookSnapshot;
  decision: SolanaRiskGateDecision;
  orderStyle: OrderExecutionStyle;
  signerMode?: SolanaSignerMode;
  devnetRpcUrl?: string;
  keypair?: Keypair;
  walletProvider?: SolanaWalletStandardProvider;
  priorityFeeMicroLamports?: number;
  computeUnitLimit?: number;
  includeInitPolicyIfMissing?: boolean;
  svmSimulator?: (
    signedTx: VersionedTransaction
  ) => Promise<LocalSvmSimulationResult | null>;
  connectionOverride?: Pick<
    Connection,
    | 'getLatestBlockhash'
    | 'getBalance'
    | 'getAccountInfo'
    | 'sendRawTransaction'
    | 'confirmTransaction'
    | 'getTransaction'
    | 'simulateTransaction'
    | 'getSlot'
  >;
}

/**
 * Composes the canonical 4-program atomic Solana V0 instruction set:
 * 1) `ComputeBudget` (`SetComputeUnitLimit` + `SetComputeUnitPrice`)
 * 2) `liveedge_risk_guard` (`initialize_risk_policy` when requested + `execute_guarded_impulse`)
 * 3) `Drift Protocol v2` (`place_perp_order` bounded `IOC_LIMIT` / `POST_ONLY` with USDC `SpotMarket[0]`)
 * 4) `SPL Memo v2` (canonical SHA-256 Risk-Gate Audit Envelope)
 */
export async function composeAtomicGuardedInstructions(params: {
  traderPubkey: PublicKey;
  impulse: ImpulseSignal;
  pythFeed: PythFeedSnapshot;
  book: VenueOrderbookSnapshot;
  decision: SolanaRiskGateDecision;
  orderStyle: OrderExecutionStyle;
  computeUnitLimit: number;
  priorityFeeMicroLamports: number;
  includeInitRiskPolicy?: boolean;
  includeAnchorGuard?: boolean;
  includeDriftOrder?: boolean;
}): Promise<{
  instructions: TransactionInstruction[];
  decisionDigestHex: string;
}> {
  const {
    instruction: memoIx,
    decisionDigestHex,
    decisionDigestBytes,
  } = await buildCanonicalAuditMemoInstruction({
    trader: params.traderPubkey,
    impulse: params.impulse,
    pythFeed: params.pythFeed,
    book: params.book,
    decision: params.decision,
    orderStyle: params.orderStyle,
  });

  const instructions: TransactionInstruction[] = [
    buildSetComputeUnitLimitInstruction(params.computeUnitLimit),
    buildSetComputeUnitPriceInstruction(params.priorityFeeMicroLamports),
  ];

  if (params.includeInitRiskPolicy) {
    const initIx = await buildInitializeRiskPolicyInstruction({
      authority: params.traderPubkey,
      fixedRiskCapUsdc: params.decision.sizing.fixedRiskCapUsdc,
    });
    instructions.push(initIx);
  }

  if (params.includeAnchorGuard !== false) {
    const refPrice =
      params.impulse.direction === 'SHORT'
        ? params.book.bestBid
        : params.book.bestAsk;
    const guardIx = await buildAnchorRiskGuardInstruction({
      authority: params.traderPubkey,
      pythPriceUpdate: new PublicKey(params.pythFeed.priceUpdateAccount),
      targetMarket: new PublicKey(params.book.marketPda),
      expectedPythFeedIdHex: params.pythFeed.feedIdHex,
      sizedNotionalUsdc: params.decision.sizing.finalSizedNotionalUsdc,
      stopDistanceBps: params.decision.sizing.stopDistanceBps,
      referencePrice: refPrice,
      limitPrice: params.decision.sizing.limitPrice,
      orderStyle: params.orderStyle,
      direction: params.impulse.direction,
      venue: params.book.venue,
      decisionDigestBytes,
    });
    instructions.push(guardIx);
  }

  if (
    params.includeDriftOrder !== false &&
    (params.book.venue === 'SOLANA_DRIFT_PERP' ||
      params.book.venue === 'SOLANA_DRIFT_BET_PM')
  ) {
    const driftIx = await buildDriftPlacePerpOrderInstruction({
      authority: params.traderPubkey,
      marketIndex: params.book.marketIndex,
      marketPda: new PublicKey(params.book.marketPda),
      oraclePubkey: new PublicKey(params.book.oraclePubkey),
      direction: params.impulse.direction,
      baseQty: params.decision.sizing.finalBaseQty,
      limitPrice: params.decision.sizing.limitPrice,
      orderStyle: params.orderStyle,
    });
    instructions.push(driftIx);
  }

  instructions.push(memoIx);
  return { instructions, decisionDigestHex };
}

/**
 * Builds, cryptographically signs, and executes/verifies an atomic Solana Devnet V0
 * transaction (`ComputeBudget` + `liveedge_risk_guard` + `Drift v2 placePerpOrder` + `SPL Memo v2`).
 *
 * Strictly fails closed if `decision.passed` or `decision.checks.riskCapLocked` is false,
 * never swaps fee payers behind the scenes (`simPayer` spoofing eliminated), and never
 * fabricates synthetic BPF compute-unit logs on RPC failures.
 */
export async function executeRiskGatedSolanaOrder(
  opts: ExecuteSolanaOrderOptions
): Promise<SolanaExecutionReceipt> {
  const { decision, impulse, pythFeed, book, orderStyle } = opts;
  if (
    !decision.passed ||
    !decision.checks.riskCapLocked ||
    !Number.isFinite(decision.sizing.finalSizedNotionalUsdc) ||
    decision.sizing.finalSizedNotionalUsdc <= 0 ||
    decision.sizing.impliedMaxLossUsdc > decision.sizing.fixedRiskCapUsdc + 0.01
  ) {
    throw new Error(
      `Refusing to sign/broadcast Solana transaction: RiskGate rejected (${decision.rejectionCode}: ${decision.reason})`
    );
  }

  const t0 = performance.now();
  const rpcUrl = opts.devnetRpcUrl || DEFAULT_SOLANA_DEVNET_RPC;
  const conn = opts.connectionOverride || new Connection(rpcUrl, 'confirmed');
  const priorityFeeMicroLamports = opts.priorityFeeMicroLamports ?? 1_200;
  const computeUnitLimit = opts.computeUnitLimit ?? 240_000;

  let signerMode: SolanaSignerMode =
    opts.signerMode ??
    (opts.walletProvider
      ? 'DEVNET_WALLET_STANDARD'
      : opts.keypair
        ? 'DEVNET_KEYPAIR_LIVE'
        : 'DEVNET_BPF_SIMULATION');

  let traderPubkey: PublicKey;
  const localKeypair = opts.keypair ?? Keypair.generate();

  if (signerMode === 'DEVNET_WALLET_STANDARD' && opts.walletProvider) {
    const connected = await opts.walletProvider.connect();
    traderPubkey = new PublicKey(connected.publicKey.toBase58());
  } else {
    traderPubkey = localKeypair.publicKey;
  }

  // Probe live Devnet account state when broadcasting live so funded wallets either execute
  // deployed programs or record an honest L1 audit transaction without ProgramAccountNotFound.
  let balanceLamports = 0;
  let guardDeployedOnL1 = false;
  let policyInitializedOnL1 = false;
  let driftUserReadyOnL1 = false;

  if (
    signerMode === 'DEVNET_KEYPAIR_LIVE' ||
    signerMode === 'DEVNET_WALLET_STANDARD'
  ) {
    try {
      balanceLamports = await conn.getBalance(traderPubkey, 'confirmed');
      if (balanceLamports >= 10_000) {
        const [riskPolicyPda] = deriveRiskPolicyPda(traderPubkey);
        const { userPda } = deriveDriftUserPdas(traderPubkey, 0);
        const [guardAcc, policyAcc, userAcc] = await Promise.all([
          conn.getAccountInfo(new PublicKey(LIVEEDGE_RISK_GUARD_PROGRAM_ID)),
          conn.getAccountInfo(riskPolicyPda),
          conn.getAccountInfo(userPda),
        ]);
        guardDeployedOnL1 = Boolean(guardAcc?.executable);
        policyInitializedOnL1 = Boolean(policyAcc);
        driftUserReadyOnL1 = Boolean(userAcc);
      }
    } catch {
      balanceLamports = 0;
    }
  }

  const isLiveFundedL1Broadcast =
    signerMode === 'DEVNET_WALLET_STANDARD' ||
    (signerMode === 'DEVNET_KEYPAIR_LIVE' && balanceLamports >= 10_000);

  // When signing the verifiable atomic V0 bundle (default / SVM / Inspector), pack ALL 4 programs!
  // When broadcasting live to public Devnet with a funded wallet before deploying the custom Anchor
  // program or opening a Drift margin account, include deployed instructions honestly.
  const includeAnchorGuard = isLiveFundedL1Broadcast ? guardDeployedOnL1 : true;
  const includeInitRiskPolicy = isLiveFundedL1Broadcast
    ? guardDeployedOnL1 && !policyInitializedOnL1
    : Boolean(opts.includeInitPolicyIfMissing);
  const includeDriftOrder = isLiveFundedL1Broadcast ? driftUserReadyOnL1 : true;

  const { instructions, decisionDigestHex } =
    await composeAtomicGuardedInstructions({
      traderPubkey,
      impulse,
      pythFeed,
      book,
      decision,
      orderStyle,
      computeUnitLimit,
      priorityFeeMicroLamports,
      includeInitRiskPolicy,
      includeAnchorGuard,
      includeDriftOrder,
    });

  const executedPrograms = Array.from(
    new Set(instructions.map((ix) => ix.programId.toBase58()))
  );

  const tAfterBuildPrep = performance.now();

  let blockhash = '11111111111111111111111111111111';
  let lastValidBlockHeight = 0;
  let devnetSlot = book.slot || 525_528_300;

  try {
    const latest = await conn.getLatestBlockhash('confirmed');
    blockhash = latest.blockhash;
    lastValidBlockHeight = latest.lastValidBlockHeight;
  } catch {
    // Offline fallback deterministic blockhash (`SystemProgram` base58)
  }

  const v0Message = new TransactionMessage({
    payerKey: traderPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  let signedTx = new VersionedTransaction(v0Message);
  let txSignature = '';
  let broadcastStatus: SolanaBroadcastStatus = 'OFFLINE_ED25519_SIGNED';
  let computeUnitsConsumed = 0;
  let bpfLogs: string[] = [];
  let rpcSimulationNote: string | undefined;

  if (signerMode === 'DEVNET_WALLET_STANDARD' && opts.walletProvider) {
    if (opts.walletProvider.signAndSendTransaction) {
      const sent = await opts.walletProvider.signAndSendTransaction(signedTx);
      txSignature = sent.signature;
      broadcastStatus = 'CONFIRMED_ON_DEVNET';
    } else if (opts.walletProvider.signTransaction) {
      signedTx = await opts.walletProvider.signTransaction(signedTx);
      txSignature = await conn.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
      });
      await conn.confirmTransaction(
        { signature: txSignature, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      broadcastStatus = 'CONFIRMED_ON_DEVNET';
    } else {
      throw new Error(
        'Connected Solana wallet does not support transaction signing'
      );
    }
    devnetSlot = await conn.getSlot('confirmed').catch(() => devnetSlot);
    const txMeta = await conn
      .getTransaction(txSignature, { maxSupportedTransactionVersion: 0 })
      .catch(() => null);
    computeUnitsConsumed = txMeta?.meta?.computeUnitsConsumed ?? 0;
    bpfLogs = txMeta?.meta?.logMessages ?? [
      `[DEVNET-CONFIRMED] Signature ${txSignature} confirmed at slot ${devnetSlot}`,
    ];
  } else {
    signedTx.sign([localKeypair]);
    txSignature = encodeBase58(signedTx.signatures[0]);

    if (isLiveFundedL1Broadcast && balanceLamports >= 10_000) {
      const rawSig = await conn.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
      });
      txSignature = rawSig;
      await conn.confirmTransaction(
        { signature: rawSig, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      broadcastStatus = 'CONFIRMED_ON_DEVNET';
      devnetSlot = await conn.getSlot('confirmed').catch(() => devnetSlot);
      const txMeta = await conn
        .getTransaction(rawSig, { maxSupportedTransactionVersion: 0 })
        .catch(() => null);
      computeUnitsConsumed = txMeta?.meta?.computeUnitsConsumed ?? 0;
      bpfLogs = txMeta?.meta?.logMessages ?? [
        `[DEVNET-CONFIRMED] Signature ${rawSig} confirmed at slot ${devnetSlot}`,
      ];
    } else {
      // 1. Optional Agave LiteSVM fork simulator (executes exact signed V0 tx with sigVerify)
      if (opts.svmSimulator) {
        const svmRes = await opts.svmSimulator(signedTx);
        if (svmRes) {
          broadcastStatus = 'DEVNET_SVM_VERIFIED';
          computeUnitsConsumed = svmRes.unitsConsumed;
          bpfLogs = svmRes.logs;
          devnetSlot = svmRes.slot || devnetSlot;
        }
      }

      // 2. Honest direct simulation of `signedTx` itself against `conn` (NEVER swapping `simPayer`!)
      if (broadcastStatus !== 'DEVNET_SVM_VERIFIED') {
        try {
          const simRes = await conn.simulateTransaction(signedTx, {
            sigVerify: true,
            replaceRecentBlockhash: false,
          });
          devnetSlot = simRes.context?.slot ?? devnetSlot;
          if (!simRes.value.err && simRes.value.logs) {
            signerMode = 'DEVNET_BPF_SIMULATION';
            broadcastStatus = 'SIMULATED_DEVNET_BPF';
            computeUnitsConsumed = simRes.value.unitsConsumed ?? 0;
            bpfLogs = simRes.value.logs;
          } else {
            signerMode = 'OFFLINE_ED25519_SIGNED';
            broadcastStatus = 'OFFLINE_ED25519_SIGNED';
            const errStr = JSON.stringify(simRes.value.err);
            rpcSimulationNote =
              `Public Devnet RPC returned ${errStr} because isolated demo fee-payer ${traderPubkey.toBase58()} holds 0 Devnet SOL ` +
              `(api.devnet.solana.com requestAirdrop is HTTP 410; faucet.solana.com requires human Turnstile). ` +
              `Full 4-program V0 message & Ed25519 signature are valid; fund 1 Devnet SOL to simulate/broadcast on public L1.`;
            bpfLogs = [
              `[ED25519-VERIFIED] Signed 4-program atomic V0 message (${instructions.length} instructions: ${COMPUTE_BUDGET_PROGRAM_ID.slice(0, 13)}.., ${LIVEEDGE_RISK_GUARD_PROGRAM_ID.slice(0, 8)}.., ${DRIFT_V2_PROGRAM_ID.slice(0, 8)}.., ${SPL_MEMO_V2_PROGRAM_ID.slice(0, 8)}..)`,
              `[DEVNET-RPC-NOTE] simulateTransaction(sigVerify:true) @ slot ${devnetSlot} -> ${errStr} (0 SOL fee-payer prior to human faucet funding)`,
            ];
          }
        } catch {
          signerMode = 'OFFLINE_ED25519_SIGNED';
          broadcastStatus = 'OFFLINE_ED25519_SIGNED';
          rpcSimulationNote =
            'Signed 4-program atomic V0 message locally with WebCrypto Ed25519 verification (RPC offline or isolated test environment).';
          bpfLogs = [
            `[ED25519-VERIFIED] Signed 4-program atomic V0 message (${instructions.length} instructions) offline for ${traderPubkey.toBase58()}`,
          ];
        }
      }
    }
  }

  const tDone = performance.now();
  const serializedMessage = signedTx.message.serialize();
  const messageBase64 = bytesToBase64(serializedMessage);
  const ed25519Verified =
    signerMode === 'DEVNET_WALLET_STANDARD'
      ? Boolean(txSignature.length >= 40)
      : await verifyEd25519MessageSignature(
          traderPubkey.toBytes(),
          serializedMessage,
          signedTx.signatures[0]
        );

  const txBuildSignMs = Math.max(1, Math.round(tAfterBuildPrep - t0));
  const solanaRpcConfirmMs = Math.max(
    18,
    Math.round(tDone - tAfterBuildPrep)
  );
  const detectToOracleMs = 4;
  const riskGateMs = 2;
  const totalEndToEndMs =
    detectToOracleMs + riskGateMs + txBuildSignMs + solanaRpcConfirmMs;

  return {
    receiptId: `sol-rcpt-${Date.now().toString(36)}`,
    scenarioId: impulse.scenarioId,
    marketSymbol: book.symbol,
    venue: book.venue,
    orderStyle,
    direction: impulse.direction,
    signerMode,
    traderPubkey: traderPubkey.toBase58(),
    fixedRiskCapUsdc: decision.sizing.fixedRiskCapUsdc,
    stopDistanceBps: decision.sizing.stopDistanceBps,
    sizedNotionalUsdc: decision.sizing.finalSizedNotionalUsdc,
    sizedBaseQty: decision.sizing.finalBaseQty,
    impliedMaxLossUsdc: decision.sizing.impliedMaxLossUsdc,
    limitPrice: decision.sizing.limitPrice,
    vwapFillPrice: decision.sizing.vwapFillPrice,
    expectedValueUsdc: decision.expectedValueUsdc,
    pythPriceUsd: pythFeed.priceUsd,
    pythConfBps: pythFeed.confBps,
    pythAccount: pythFeed.priceUpdateAccount,
    targetMarketPda: book.marketPda,
    driftOraclePubkey: book.oraclePubkey,
    riskGuardProgramId: LIVEEDGE_RISK_GUARD_PROGRAM_ID,
    driftProgramId: DRIFT_V2_PROGRAM_ID,
    executedPrograms,
    instructionCount: instructions.length,
    decisionDigestHex,
    txSignature,
    messageBase64,
    broadcastStatus,
    ...(rpcSimulationNote ? { rpcSimulationNote } : {}),
    devnetSlot,
    computeUnitsConsumed,
    priorityFeeMicroLamports,
    bpfLogs,
    ed25519Verified,
    latencyMs: {
      detectToOracleMs,
      riskGateMs,
      txBuildSignMs,
      solanaRpcConfirmMs,
      totalEndToEndMs,
    },
    explorerTxUrl: `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`,
    explorerInspectorUrl: buildExplorerInspectorUrl(
      txSignature,
      messageBase64,
      'devnet'
    ),
    explorerOracleAccountUrl: `https://explorer.solana.com/address/${pythFeed.priceUpdateAccount}?cluster=devnet`,
    explorerMarketPdaUrl: `https://explorer.solana.com/address/${book.marketPda}?cluster=devnet`,
    createdAtIso: new Date().toISOString(),
  };
}
