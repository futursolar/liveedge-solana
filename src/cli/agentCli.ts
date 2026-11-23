import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import type { OrderExecutionStyle, ScenarioId } from '../engine/types';
import {
  DEFAULT_SOLANA_RISK_CONFIG,
  evaluateSolanaRiskGate,
} from '../engine/solanaRiskGate';
import { fetchLivePythFeeds } from '../oracle/pythHermesGuard';
import {
  DEFAULT_SOLANA_DEVNET_RPC,
  executeRiskGatedSolanaOrder,
} from '../solana/devnetExecutor';
import {
  ALL_SCENARIO_IDS,
  buildScenarioBundle,
  fetchLiveDriftPerpMarkets,
} from '../venues/marketDataClient';

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function loadOptionalDevnetKeypair(keypairPath?: string): Keypair | undefined {
  const resolved = keypairPath || process.env.LIVEEDGE_DEVNET_KEYPAIR_PATH;
  if (!resolved || !fs.existsSync(resolved)) {
    return undefined;
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as
    | number[]
    | { secretKeyArray?: number[] };
  const bytes = Array.isArray(raw) ? raw : raw.secretKeyArray;
  if (!bytes || bytes.length !== 64) {
    throw new Error('Invalid 64-byte Solana Devnet keypair JSON');
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export async function runAgentCli(argv = process.argv.slice(2)): Promise<number> {
  const sub = argv[0] || 'status';
  const jsonMode = argv.includes('--json');

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(
      [
        'LiveEdge Solana Agent CLI — Risk-Gated Impulse Execution for Solana Perps & Prediction Markets',
        '',
        'Usage:',
        '  liveedge-solana status [--json]',
        '  liveedge-solana scenarios [--json]',
        '  liveedge-solana pulse [--scenario <id>] [--risk-cap <usdc>] [--style <IOC_LIMIT|POST_ONLY>] [--keypair <path>] [--json]',
      ].join('\n')
    );
    return 0;
  }

  if (sub === 'scenarios') {
    const rows = ALL_SCENARIO_IDS.map((id) => {
      const bundle = buildScenarioBundle(id);
      const decision = evaluateSolanaRiskGate(
        bundle.impulse,
        bundle.pythFeed,
        bundle.orderbook
      );
      return {
        scenarioId: id,
        market: bundle.orderbook.symbol,
        venue: bundle.orderbook.venue,
        passed: decision.passed,
        rejectionCode: decision.rejectionCode,
        sizedNotionalUsdc: decision.sizing.finalSizedNotionalUsdc,
        impliedMaxLossUsdc: decision.sizing.impliedMaxLossUsdc,
        reason: decision.reason,
      };
    });
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, scenarios: rows }, null, 2));
    } else {
      for (const r of rows) {
        console.log(
          `[${r.passed ? 'PASS ' : 'BLOCK'}] ${r.scenarioId.padEnd(24)} | ${r.market.padEnd(15)} | Size $${r.sizedNotionalUsdc.toFixed(2).padStart(7)} | ${r.reason}`
        );
      }
    }
    return 0;
  }

  const liveFeeds = await fetchLivePythFeeds({
    hermesBearerToken: process.env.PYTH_API_KEY,
    timeoutMs: 4000,
  });

  if (sub === 'status') {
    const devnetRpc =
      process.env.SOLANA_DEVNET_RPC_URL || DEFAULT_SOLANA_DEVNET_RPC;
    const driftPerpState = await fetchLiveDriftPerpMarkets(devnetRpc, 4000);
    const payload = {
      ok: true,
      cluster: 'devnet',
      devnetRpc,
      pythFeeds: liveFeeds,
      driftPerpMarkets: driftPerpState,
    };
    if (jsonMode) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log('=== LiveEdge Solana Telemetry Status ===');
      for (const feed of Object.values(liveFeeds)) {
        console.log(
          `  [Pyth]  ${feed.symbol}: $${feed.priceUsd.toFixed(4)} ±$${feed.confUsd.toFixed(4)} (${feed.confBps.toFixed(2)} bps) | Age ${(feed.ageMs / 1000).toFixed(1)}s | Source: ${feed.source}`
        );
      }
      for (const [sym, st] of Object.entries(driftPerpState)) {
        console.log(
          `  [Drift] ${sym}: vAMM Reserve $${st.reservePriceUsd.toFixed(4)} | sqrtK ${st.sqrtKBase.toFixed(0)} | Delay ${st.lastOracleDelaySlots} slots`
        );
      }
    }
    return 0;
  }

  if (sub === 'pulse') {
    const rawScenario = (parseArg(argv, '--scenario') ||
      'sol-perp-breakout') as ScenarioId;
    if (!ALL_SCENARIO_IDS.includes(rawScenario)) {
      console.error(`Unknown --scenario: ${rawScenario}`);
      return 1;
    }
    const requestedRisk = Number(
      parseArg(argv, '--risk-cap') ||
        DEFAULT_SOLANA_RISK_CONFIG.fixedRiskCapUsdc
    );
    const styleArg = parseArg(argv, '--style');
    const orderStyle: OrderExecutionStyle =
      styleArg === 'POST_ONLY' ? 'POST_ONLY' : 'IOC_LIMIT';
    const keypair = loadOptionalDevnetKeypair(parseArg(argv, '--keypair'));

    const bundle = buildScenarioBundle(rawScenario, liveFeeds);
    const decision = evaluateSolanaRiskGate(
      bundle.impulse,
      bundle.pythFeed,
      bundle.orderbook,
      requestedRisk
    );

    if (!decision.passed) {
      const blockedPayload = {
        ok: true,
        action: 'FAIL_CLOSED_BLOCKED',
        scenarioId: rawScenario,
        market: bundle.orderbook.symbol,
        decision,
      };
      if (jsonMode) {
        console.log(JSON.stringify(blockedPayload, null, 2));
      } else {
        console.log(`🛑 [FAIL-CLOSED BLOCKED] ${decision.reason}`);
      }
      return 0;
    }

    const receipt = await executeRiskGatedSolanaOrder({
      impulse: bundle.impulse,
      pythFeed: bundle.pythFeed,
      book: bundle.orderbook,
      decision,
      orderStyle,
      keypair,
      signerMode: keypair ? 'DEVNET_KEYPAIR_LIVE' : 'DEVNET_BPF_SIMULATION',
      devnetRpcUrl:
        process.env.SOLANA_DEVNET_RPC_URL || DEFAULT_SOLANA_DEVNET_RPC,
    });

    if (jsonMode) {
      console.log(
        JSON.stringify(
          { ok: true, action: 'EXECUTED', decision, receipt },
          null,
          2
        )
      );
    } else {
      console.log(`✅ [SOLANA DEVNET EXECUTED] ${receipt.marketSymbol} ${receipt.direction}`);
      console.log(
        `   Sized Notional: $${receipt.sizedNotionalUsdc.toFixed(2)} (${receipt.sizedBaseQty} base) | Max Loss Locked: $${receipt.impliedMaxLossUsdc.toFixed(2)}`
      );
      console.log(`   Tx Signature:   ${receipt.txSignature}`);
      console.log(`   Status / Slot:  ${receipt.broadcastStatus} @ Slot ${receipt.devnetSlot} (${receipt.computeUnitsConsumed} CU)`);
      console.log(`   Verify URL:     ${receipt.explorerInspectorUrl}`);
    }
    return 0;
  }

  console.error(`Unknown subcommand: ${sub}`);
  return 1;
}
