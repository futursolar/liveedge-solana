import fs from 'node:fs';
import path from 'node:path';
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { address, getTransactionDecoder, lamports } from '@solana/kit';
import { LiteSVM, TransactionMetadata } from 'litesvm';
import { describe, expect, it, vi } from 'vitest';
import { runAgentCli } from '../src/cli/agentCli';
import { evaluateSolanaRiskGate } from '../src/engine/solanaRiskGate';
import {
  executeRiskGatedSolanaOrder,
  verifyEd25519MessageSignature,
} from '../src/solana/devnetExecutor';
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
  deriveDriftSpotMarketPda,
  deriveRiskPolicyPda,
  sha256Bytes,
} from '../src/solana/driftInstructionBuilder';
import {
  DRIFT_DEVNET_USDC_SPOT_MARKET_PDA,
  DRIFT_DEVNET_USDC_SPOT_ORACLE,
  DRIFT_V2_PROGRAM_ID,
  buildScenarioBundle,
} from '../src/venues/marketDataClient';

describe('Anchor Risk Guard & Drift v2 Borsh Instruction Encoders', () => {
  it('encodes Anchor initializeRiskPolicy + executeGuardedImpulse and Drift bounded Limit order with USDC SpotMarket[0]', async () => {
    const trader = Keypair.generate();
    const bundle = buildScenarioBundle('sol-perp-breakout');
    const digest = await sha256Bytes('test-decision-digest');

    const initIx = await buildInitializeRiskPolicyInstruction({
      authority: trader.publicKey,
      fixedRiskCapUsdc: 10.0,
    });
    expect(initIx.programId.toBase58()).toBe(LIVEEDGE_RISK_GUARD_PROGRAM_ID);
    expect(initIx.data.length).toBe(30);

    const anchorIx = await buildAnchorRiskGuardInstruction({
      authority: trader.publicKey,
      pythPriceUpdate: new PublicKey(bundle.pythFeed.priceUpdateAccount),
      targetMarket: new PublicKey(bundle.orderbook.marketPda),
      expectedPythFeedIdHex: bundle.pythFeed.feedIdHex,
      sizedNotionalUsdc: 800,
      stopDistanceBps: 125,
      referencePrice: bundle.orderbook.bestAsk,
      limitPrice: bundle.orderbook.bestAsk * 1.0015,
      orderStyle: 'IOC_LIMIT',
      direction: 'LONG',
      venue: 'SOLANA_DRIFT_PERP',
      decisionDigestBytes: digest,
    });

    expect(anchorIx.programId.toBase58()).toBe(LIVEEDGE_RISK_GUARD_PROGRAM_ID);
    expect(anchorIx.data.length).toBe(101);
    expect(anchorIx.data[66]).toBe(1); // OrderMode::IocLimit (never 0 BlindMarket)
    expect(anchorIx.data[67]).toBe(0); // TradeSide::Long
    expect(anchorIx.data[68]).toBe(0); // MarketKind::Perp
    const [expectedPolicyPda] = deriveRiskPolicyPda(trader.publicKey);
    expect(anchorIx.keys[1].pubkey.toBase58()).toBe(
      expectedPolicyPda.toBase58()
    );

    // Verify derived SpotMarket[0] PDA matches live Drift Devnet USDC SpotMarket[0]
    expect(deriveDriftSpotMarketPda(0).toBase58()).toBe(
      DRIFT_DEVNET_USDC_SPOT_MARKET_PDA
    );

    const driftIocIx = await buildDriftPlacePerpOrderInstruction({
      authority: trader.publicKey,
      marketIndex: 0,
      marketPda: new PublicKey(bundle.orderbook.marketPda),
      oraclePubkey: new PublicKey(bundle.orderbook.oraclePubkey),
      direction: 'LONG',
      baseQty: 10.79,
      limitPrice: 74.18,
      orderStyle: 'IOC_LIMIT',
    });
    expect(driftIocIx.data[8]).toBe(1); // Drift OrderType::Limit = 1 (never 0 Market)
    expect(driftIocIx.data[30]).toBe(0); // reduce_only = false
    expect(driftIocIx.data[31]).toBe(0); // post_only = None
    expect(driftIocIx.data[32]).toBe(1); // immediate_or_cancel = true

    // Verify Drift v2 remaining_accounts order: [state, user, authority, usdcOracle, perpOracle, usdcSpotMarket0, perpMarket]
    const keyAddrs = driftIocIx.keys.map((k) => k.pubkey.toBase58());
    expect(keyAddrs[3]).toBe(DRIFT_DEVNET_USDC_SPOT_ORACLE);
    expect(keyAddrs[4]).toBe(bundle.orderbook.oraclePubkey);
    expect(keyAddrs[5]).toBe(DRIFT_DEVNET_USDC_SPOT_MARKET_PDA);
    expect(keyAddrs[6]).toBe(bundle.orderbook.marketPda);

    const driftShortPostOnlyIx = await buildDriftPlacePerpOrderInstruction({
      authority: trader.publicKey,
      marketIndex: 0,
      marketPda: new PublicKey(bundle.orderbook.marketPda),
      oraclePubkey: new PublicKey(bundle.orderbook.oraclePubkey),
      direction: 'SHORT',
      baseQty: 10.79,
      limitPrice: 73.85,
      orderStyle: 'POST_ONLY',
    });
    expect(driftShortPostOnlyIx.data[10]).toBe(1); // PositionDirection::Short = 1
    expect(driftShortPostOnlyIx.data[31]).toBe(1); // PostOnlyParam::MustPostOnly
    expect(driftShortPostOnlyIx.data[32]).toBe(0); // immediate_or_cancel = false
  });
});

describe('Solana Devnet Executor, Agave LiteSVM Verification & Anti-Spoofing Guards', () => {
  it('refuses to sign or broadcast any transaction when RiskGate decision is rejected', async () => {
    const nowMs = Date.now();
    const blocked = buildScenarioBundle(
      'btc-cpi-conf-blowout',
      undefined,
      nowMs
    );
    const decision = evaluateSolanaRiskGate(
      blocked.impulse,
      blocked.pythFeed,
      blocked.orderbook,
      10.0,
      undefined,
      nowMs
    );
    expect(decision.passed).toBe(false);

    await expect(
      executeRiskGatedSolanaOrder({
        impulse: blocked.impulse,
        pythFeed: blocked.pythFeed,
        book: blocked.orderbook,
        decision,
        orderStyle: 'IOC_LIMIT',
      })
    ).rejects.toThrow(/Refusing to sign\/broadcast/);
  });

  it('packs all 4 canonical programs into unfunded V0 bundle, never spoofs simPayer, never fakes CU logs, and fails closed on WebCrypto errors', async () => {
    const nowMs = Date.now();
    const bundle = buildScenarioBundle('sol-perp-breakout', undefined, nowMs);
    const decision = evaluateSolanaRiskGate(
      bundle.impulse,
      bundle.pythFeed,
      bundle.orderbook,
      10.0,
      undefined,
      nowMs
    );
    const trader = Keypair.generate();

    const simulatedPayers: string[] = [];
    const unfundedConn = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 525_530_000,
      }),
      getBalance: vi.fn().mockResolvedValue(0),
      getAccountInfo: vi.fn().mockResolvedValue(null),
      sendRawTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getTransaction: vi.fn(),
      simulateTransaction: vi
        .fn()
        .mockImplementation(async (tx: VersionedTransaction) => {
          simulatedPayers.push(tx.message.staticAccountKeys[0].toBase58());
          return {
            context: { slot: 525_528_900 },
            value: { err: 'AccountNotFound', logs: [] },
          };
        }),
      getSlot: vi.fn().mockResolvedValue(525_528_900),
    };

    const receipt = await executeRiskGatedSolanaOrder({
      impulse: bundle.impulse,
      pythFeed: bundle.pythFeed,
      book: bundle.orderbook,
      decision,
      orderStyle: 'IOC_LIMIT',
      signerMode: 'DEVNET_KEYPAIR_LIVE',
      keypair: trader,
      connectionOverride: unfundedConn,
    });

    // 1. Exact fee-payer simulated is `trader` (NEVER a random stranger from SPL_MEMO_V2!)
    expect(simulatedPayers).toEqual([trader.publicKey.toBase58()]);

    // 2. All 4 programs packed into the signed V0 bundle (`instructionCount = 5`)
    expect(receipt.instructionCount).toBe(5);
    expect(receipt.executedPrograms).toEqual([
      COMPUTE_BUDGET_PROGRAM_ID,
      LIVEEDGE_RISK_GUARD_PROGRAM_ID,
      DRIFT_V2_PROGRAM_ID,
      SPL_MEMO_V2_PROGRAM_ID,
    ]);

    // 3. Honest unfunded status & zero fabricated CU logs
    expect(receipt.broadcastStatus).toBe('OFFLINE_ED25519_SIGNED');
    expect(receipt.computeUnitsConsumed).toBe(0);
    expect(receipt.ed25519Verified).toBe(true);
    expect(receipt.rpcSimulationNote).toContain('AccountNotFound');

    // 4. WebCrypto Ed25519 tamper & runtime-exception fail-closed checks
    const badSig = new Uint8Array(64).fill(7);
    expect(
      await verifyEd25519MessageSignature(
        trader.publicKey.toBytes(),
        new Uint8Array([1, 2, 3]),
        badSig
      )
    ).toBe(false);

    const verifySpy = vi
      .spyOn(crypto.subtle, 'verify')
      .mockRejectedValueOnce(new Error('Simulated WebCrypto failure'));
    try {
      const resOnThrow = await verifyEd25519MessageSignature(
        trader.publicKey.toBytes(),
        new Uint8Array([1, 2, 3]),
        badSig
      );
      expect(resOnThrow).toBe(false);
    } finally {
      verifySpy.mockRestore();
    }
  });

  it('signs V0 transaction and broadcasts live when funded on Devnet, and executes 3-instruction ComputeBudget + SPL Memo v2 audit envelope in Agave LiteSVM', async () => {
    const nowMs = Date.now();
    const bundle = buildScenarioBundle('sol-perp-breakout', undefined, nowMs);
    const decision = evaluateSolanaRiskGate(
      bundle.impulse,
      bundle.pythFeed,
      bundle.orderbook,
      10.0,
      undefined,
      nowMs
    );
    const trader = Keypair.generate();

    // Part A: Standalone 3-instruction ComputeBudget + SPL Memo v2 audit-envelope execution in Agave LiteSVM (`withSigverify(true)`)
    const svm = new LiteSVM().withDefaultPrograms().withSigverify(true);
    svm.airdrop(address(trader.publicKey.toBase58()), lamports(1_000_000_000n));
    const { instruction: memoIx } = await buildCanonicalAuditMemoInstruction({
      trader: trader.publicKey,
      impulse: bundle.impulse,
      pythFeed: bundle.pythFeed,
      book: bundle.orderbook,
      decision,
      orderStyle: 'IOC_LIMIT',
    });
    const svmMsg = new TransactionMessage({
      payerKey: trader.publicKey,
      recentBlockhash: svm.latestBlockhash(),
      instructions: [
        buildSetComputeUnitLimitInstruction(200_000),
        buildSetComputeUnitPriceInstruction(1_200),
        memoIx,
      ],
    }).compileToV0Message();
    const svmTx = new VersionedTransaction(svmMsg);
    svmTx.sign([trader]);
    const kitTx = getTransactionDecoder().decode(svmTx.serialize());
    const svmMeta = svm.sendTransaction(kitTx);
    expect(svmMeta).toBeInstanceOf(TransactionMetadata);
    const okMeta = svmMeta as TransactionMetadata;
    expect(Number(okMeta.computeUnitsConsumed())).toBeGreaterThan(1_000);
    expect(
      okMeta.logs().some((l: string) => l.includes(SPL_MEMO_V2_PROGRAM_ID))
    ).toBe(true);

    // Part B: Funded Devnet RPC live broadcast path (`CONFIRMED_ON_DEVNET`)
    let sentRawBytes: Uint8Array | null = null;
    const fundedConn = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 525_530_000,
      }),
      getBalance: vi.fn().mockResolvedValue(500_000_000), // 0.5 Devnet SOL
      getAccountInfo: vi
        .fn()
        .mockResolvedValue({ executable: true, data: Buffer.alloc(64) }),
      sendRawTransaction: vi
        .fn()
        .mockImplementation(async (raw: Uint8Array) => {
          sentRawBytes = raw;
          return '4KZCmRYonzuuMd72PpHBovaosjT54eEvb6X2Br8mYnMQKbph3RyJ331A7wZvg4AXLakKHe2s7QBT2K5sjUUiyyn6';
        }),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getTransaction: vi.fn().mockResolvedValue({
        meta: {
          computeUnitsConsumed: 42_180,
          logMessages: [
            `Program ${LIVEEDGE_RISK_GUARD_PROGRAM_ID} success`,
            `Program ${DRIFT_V2_PROGRAM_ID} success`,
            `Program ${SPL_MEMO_V2_PROGRAM_ID} success`,
          ],
        },
      }),
      simulateTransaction: vi.fn(),
      getSlot: vi.fn().mockResolvedValue(525_529_777),
    };

    const receipt = await executeRiskGatedSolanaOrder({
      impulse: bundle.impulse,
      pythFeed: bundle.pythFeed,
      book: bundle.orderbook,
      decision,
      orderStyle: 'IOC_LIMIT',
      signerMode: 'DEVNET_KEYPAIR_LIVE',
      keypair: trader,
      connectionOverride: fundedConn,
    });

    expect(sentRawBytes).not.toBeNull();
    expect(receipt.broadcastStatus).toBe('CONFIRMED_ON_DEVNET');
    expect(receipt.ed25519Verified).toBe(true);
    expect(receipt.computeUnitsConsumed).toBe(42_180);
    expect(receipt.executedPrograms).toContain(LIVEEDGE_RISK_GUARD_PROGRAM_ID);
    expect(receipt.executedPrograms).toContain(DRIFT_V2_PROGRAM_ID);
    expect(receipt.devnetSlot).toBe(525_529_777);
    // Rejects tampered decision exceeding fixedRiskCapUsdc by even +$0.01 (zero +0.01 tolerance)
    await expect(
      executeRiskGatedSolanaOrder({
        impulse: bundle.impulse,
        pythFeed: bundle.pythFeed,
        book: bundle.orderbook,
        decision: {
          ...decision,
          sizing: {
            ...decision.sizing,
            finalSizedNotionalUsdc: 666.67,
            stopDistanceBps: 150,
            impliedMaxLossUsdc: 10.01,
          },
        },
        orderStyle: 'IOC_LIMIT',
      })
    ).rejects.toThrow(/Refusing to sign\/broadcast/);
  });

  it('verifies every flagship receipt in docs/DEVNET_EVIDENCE.json satisfies Ed25519 signature and on-chain Rust u128 bounds', async () => {
    const evidencePath = path.resolve(__dirname, '../docs/DEVNET_EVIDENCE.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    expect(evidence.executedDevnetReceipts.length).toBeGreaterThanOrEqual(2);
    expect(evidence.agaveLiteSvmVerifiedProofs.length).toBeGreaterThanOrEqual(2);

    for (const proof of evidence.agaveLiteSvmVerifiedProofs) {
      expect(proof.scope).toBe('MEMO_AUDIT_ENVELOPE_ONLY');
      expect(proof.instructionCount).toBe(3);
      expect(proof.executedPrograms).toEqual([
        COMPUTE_BUDGET_PROGRAM_ID,
        SPL_MEMO_V2_PROGRAM_ID,
      ]);
    }

    const bs58Decode = (str: string): Uint8Array => {
      const alphabet =
        '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let num = 0n;
      for (const ch of str) {
        const idx = alphabet.indexOf(ch);
        if (idx < 0) throw new Error(`Invalid base58 char: ${ch}`);
        num = num * 58n + BigInt(idx);
      }
      let hex = num === 0n ? '' : num.toString(16);
      if (hex.length % 2 === 1) hex = '0' + hex;
      const raw = new Uint8Array(hex.length / 2);
      for (let i = 0; i < raw.length; i++) {
        raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      let leadingZeros = 0;
      for (const ch of str) {
        if (ch === '1') leadingZeros++;
        else break;
      }
      const out = new Uint8Array(leadingZeros + raw.length);
      out.set(raw, leadingZeros);
      return out;
    };

    for (const rcpt of evidence.executedDevnetReceipts) {
      const msgBytes = new Uint8Array(Buffer.from(rcpt.messageBase64, 'base64'));
      const sigBytes = bs58Decode(rcpt.txSignature);
      const pubBytes = new PublicKey(rcpt.traderPubkey).toBytes();
      expect(
        await verifyEd25519MessageSignature(pubBytes, msgBytes, sigBytes)
      ).toBe(true);

      const v0Msg = VersionedMessage.deserialize(msgBytes);
      const guardIx = v0Msg.compiledInstructions.find(
        (ix) =>
          v0Msg.staticAccountKeys[ix.programIdIndex].toBase58() ===
          LIVEEDGE_RISK_GUARD_PROGRAM_ID
      );
      expect(guardIx).toBeDefined();
      expect(guardIx!.data.length).toBe(101);

      const view = new DataView(
        guardIx!.data.buffer,
        guardIx!.data.byteOffset,
        guardIx!.data.byteLength
      );
      const sizedNotionalE6 = view.getBigUint64(40, true);
      const stopBps = BigInt(view.getUint16(48, true));
      const refE6 = view.getBigUint64(50, true);
      const limE6 = view.getBigUint64(58, true);
      const orderMode = view.getUint8(66);
      const tradeSide = view.getUint8(67);
      const marketKind = view.getUint8(68);
      const capE6 = BigInt(Math.round(rcpt.fixedRiskCapUsdc * 1_000_000));

      expect([1, 2]).toContain(orderMode);
      expect(sizedNotionalE6 * stopBps).toBeLessThanOrEqual(capE6 * 10_000n);

      if (marketKind === 0) {
        const oracleE6 = BigInt(Math.round(rcpt.pythPriceUsd * 1_000_000));
        const absDev = refE6 >= oracleE6 ? refE6 - oracleE6 : oracleE6 - refE6;
        expect(absDev * 10_000n).toBeLessThanOrEqual(oracleE6 * 150n);
        if (tradeSide === 0) {
          expect(limE6).toBeLessThanOrEqual((refE6 * 10_020n) / 10_000n);
          expect(limE6).toBeLessThanOrEqual((oracleE6 * 10_170n) / 10_000n);
        } else {
          expect(limE6).toBeGreaterThanOrEqual((refE6 * 9_980n) / 10_000n);
          expect(limE6).toBeGreaterThanOrEqual((oracleE6 * 9_830n) / 10_000n);
        }
      } else {
        expect(refE6).toBeGreaterThanOrEqual(10_000n);
        expect(refE6).toBeLessThanOrEqual(990_000n);
        expect(limE6).toBeGreaterThanOrEqual(10_000n);
        expect(limE6).toBeLessThanOrEqual(990_000n);
        if (tradeSide === 0) {
          expect(limE6).toBeLessThanOrEqual(refE6 + 15_000n);
        } else {
          expect(limE6 + 15_000n).toBeGreaterThanOrEqual(refE6);
        }
      }
    }
  });

  it('executes Agent CLI scenarios and pulse subcommands cleanly with exit code 0', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(String(msg));
    });
    try {
      const code = await runAgentCli(['scenarios', '--json']);
      expect(code).toBe(0);
      const parsed = JSON.parse(logs.join('\n'));
      expect(parsed.ok).toBe(true);
      expect(parsed.scenarios).toHaveLength(6);
    } finally {
      spy.mockRestore();
    }

    const pulseLogs: string[] = [];
    const spy2 = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      pulseLogs.push(String(msg));
    });
    try {
      const code2 = await runAgentCli([
        'pulse',
        '--scenario',
        'btc-cpi-conf-blowout',
        '--json',
      ]);
      expect(code2).toBe(0);
      const parsedBlocked = JSON.parse(pulseLogs.join('\n'));
      expect(parsedBlocked.action).toBe('FAIL_CLOSED_BLOCKED');
      expect(parsedBlocked.decision.rejectionCode).toBe(
        'ORACLE_CONFIDENCE_TOO_WIDE'
      );
    } finally {
      spy2.mockRestore();
    }
  });
});
