import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { runAgentCli } from '../src/cli/agentCli';
import { evaluateSolanaRiskGate } from '../src/engine/solanaRiskGate';
import {
  executeRiskGatedSolanaOrder,
  verifyEd25519MessageSignature,
} from '../src/solana/devnetExecutor';
import {
  LIVEEDGE_RISK_GUARD_PROGRAM_ID,
  buildAnchorRiskGuardInstruction,
  buildDriftPlacePerpOrderInstruction,
  deriveRiskPolicyPda,
  sha256Bytes,
} from '../src/solana/driftInstructionBuilder';
import { buildScenarioBundle } from '../src/venues/marketDataClient';

describe('Anchor Risk Guard & Drift v2 Borsh Instruction Encoders', () => {
  it('encodes Anchor executeGuardedImpulse and Drift bounded Limit order (never Market order)', async () => {
    const trader = Keypair.generate();
    const bundle = buildScenarioBundle('sol-perp-breakout');
    const digest = await sha256Bytes('test-decision-digest');

    const anchorIx = await buildAnchorRiskGuardInstruction({
      authority: trader.publicKey,
      pythPriceUpdate: new PublicKey(bundle.pythFeed.priceUpdateAccount),
      targetMarket: new PublicKey(bundle.orderbook.marketPda),
      expectedPythFeedIdHex: bundle.pythFeed.feedIdHex,
      sizedNotionalUsdc: 800,
      stopDistanceBps: 125,
      referenceAsk: bundle.orderbook.bestAsk,
      limitPrice: bundle.orderbook.bestAsk * 1.0015,
      orderStyle: 'IOC_LIMIT',
      decisionDigestBytes: digest,
    });

    expect(anchorIx.programId.toBase58()).toBe(LIVEEDGE_RISK_GUARD_PROGRAM_ID);
    expect(anchorIx.data.length).toBe(99);
    expect(anchorIx.data[66]).toBe(1); // OrderMode::IocLimit (never 0 BlindMarket)
    const [expectedPolicyPda] = deriveRiskPolicyPda(trader.publicKey);
    expect(anchorIx.keys[1].pubkey.toBase58()).toBe(expectedPolicyPda.toBase58());

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

    const driftPostOnlyIx = await buildDriftPlacePerpOrderInstruction({
      authority: trader.publicKey,
      marketIndex: 0,
      marketPda: new PublicKey(bundle.orderbook.marketPda),
      oraclePubkey: new PublicKey(bundle.orderbook.oraclePubkey),
      direction: 'LONG',
      baseQty: 10.79,
      limitPrice: 74.18,
      orderStyle: 'POST_ONLY',
    });
    expect(driftPostOnlyIx.data[31]).toBe(1); // PostOnlyParam::MustPostOnly
    expect(driftPostOnlyIx.data[32]).toBe(0); // immediate_or_cancel = false
  });
});

describe('Solana Devnet Executor & Fail-Closed Second-Layer Guard', () => {
  it('refuses to sign or broadcast any transaction when RiskGate decision is rejected', async () => {
    const nowMs = Date.now();
    const blocked = buildScenarioBundle('btc-cpi-conf-blowout', undefined, nowMs);
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

  it('signs V0 transaction with verified Ed25519 signature and broadcasts when funded on Devnet', async () => {
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
    let sentRawBytes: Uint8Array | null = null;

    const fakeConn = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 500_000_000,
      }),
      getBalance: vi.fn().mockResolvedValue(500_000_000), // 0.5 Devnet SOL
      getAccountInfo: vi.fn().mockResolvedValue(null),
      sendRawTransaction: vi.fn().mockImplementation(async (raw: Uint8Array) => {
        sentRawBytes = raw;
        return '4KZCmRYonzuuMd72PpHBovaosjT54eEvb6X2Br8mYnMQKbph3RyJ331A7wZvg4AXLakKHe2s7QBT2K5sjUUiyyn6';
      }),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getSignaturesForAddress: vi.fn().mockResolvedValue([]),
      getTransaction: vi.fn().mockResolvedValue(null),
      simulateTransaction: vi.fn(),
      getSlot: vi.fn().mockResolvedValue(525_507_777),
    };

    const receipt = await executeRiskGatedSolanaOrder({
      impulse: bundle.impulse,
      pythFeed: bundle.pythFeed,
      book: bundle.orderbook,
      decision,
      orderStyle: 'IOC_LIMIT',
      signerMode: 'DEVNET_KEYPAIR_LIVE',
      keypair: trader,
      connectionOverride: fakeConn,
    });

    expect(sentRawBytes).not.toBeNull();
    expect(receipt.broadcastStatus).toBe('CONFIRMED_ON_DEVNET');
    expect(receipt.ed25519Verified).toBe(true);
    expect(receipt.devnetSlot).toBe(525_507_777);
    expect(receipt.impliedMaxLossUsdc).toBeLessThanOrEqual(10.0);
    expect(receipt.explorerTxUrl).toContain('cluster=devnet');
    expect(receipt.explorerInspectorUrl).toContain('explorer.solana.com/tx/inspector?cluster=devnet');

    // Also test direct Ed25519 negative tamper check
    const badSig = new Uint8Array(64).fill(7);
    const verifiedBad = await verifyEd25519MessageSignature(
      trader.publicKey.toBytes(),
      new Uint8Array([1, 2, 3]),
      badSig
    );
    expect(verifiedBad).toBe(false);
  });

  it('executes Agent CLI scenarios subcommand cleanly with exit code 0', async () => {
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

    // Verify pulse subcommand produces deterministic JSON on blocked & passed scenarios
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
