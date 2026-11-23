import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOLANA_RISK_CONFIG,
  evaluateSolanaRiskGate,
  sizePositionByFixedLoss,
} from '../src/engine/solanaRiskGate';
import {
  PYTH_CANONICAL_FEEDS,
  decodePythPriceUpdateV2,
  evaluatePythOracleGuard,
} from '../src/oracle/pythHermesGuard';
import {
  ALL_SCENARIO_IDS,
  buildScenarioBundle,
  simulateOrderbookVwapFill,
} from '../src/venues/marketDataClient';

function hexToUint8(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

// Authentic 134-byte Pyth Solana Receiver `PriceUpdateV2` hex vector captured from Solana RPC (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`)
const REAL_SOL_PRICE_UPDATE_V2_HEX =
  '22f123639d7ef4cd60314704340deddf371fd42472148f248e9d1a6d1a5eb2ac3acd8b7fd5d6b24301ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56dede796bb01000000a575220000000000f8ffffff3b75046b000000003a75046b00000000bc920abe010000001cbc22000000000088c3311c0000000000';

describe('Pyth PriceUpdateV2 Binary Decoder & Confidence/Staleness Guard', () => {
  it('decodes authentic 134-byte Solana PriceUpdateV2 SOL/USD binary account accurately', () => {
    const raw = hexToUint8(REAL_SOL_PRICE_UPDATE_V2_HEX);
    const publishSec = 0x6b04753b; // 1795454267
    const snapshot = decodePythPriceUpdateV2(
      raw,
      PYTH_CANONICAL_FEEDS.SOL.solanaPriceUpdateAccount,
      'SOL',
      74.85,
      (publishSec + 8) * 1000
    );

    expect(snapshot.asset).toBe('SOL');
    expect(snapshot.feedIdHex).toBe(PYTH_CANONICAL_FEEDS.SOL.feedIdHex);
    expect(snapshot.priceUsd).toBeCloseTo(74.421965, 5);
    expect(snapshot.confUsd).toBeCloseTo(0.022583, 5);
    expect(snapshot.confBps).toBeCloseTo(3.03, 1);
    expect(snapshot.ageMs).toBe(8000);
    expect(snapshot.postedSlot).toBe(473023368);

    const verdict = evaluatePythOracleGuard(snapshot, 45_000, 30);
    expect(verdict.passed).toBe(true);
    expect(verdict.rejectionCode).toBe('NONE');
  });

  it('rejects corrupted discriminator, stale frames, and wide confidence intervals', () => {
    const badBytes = hexToUint8(REAL_SOL_PRICE_UPDATE_V2_HEX);
    badBytes[0] = 0xff;
    expect(() =>
      decodePythPriceUpdateV2(badBytes, '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE')
    ).toThrow(/discriminator/i);

    const staleBundle = buildScenarioBundle('eth-stale-oracle-trap');
    const staleVerdict = evaluatePythOracleGuard(staleBundle.pythFeed, 45_000, 30);
    expect(staleVerdict.passed).toBe(false);
    expect(staleVerdict.rejectionCode).toBe('ORACLE_STALE_FRAME');

    const wideConfBundle = buildScenarioBundle('btc-cpi-conf-blowout');
    const wideVerdict = evaluatePythOracleGuard(wideConfBundle.pythFeed, 45_000, 30);
    expect(wideVerdict.passed).toBe(false);
    expect(wideVerdict.rejectionCode).toBe('ORACLE_CONFIDENCE_TOO_WIDE');
  });
});

describe('Fixed-Loss Position Sizer & 8-Gate Fail-Closed Solana Risk Engine', () => {
  it('computes exact stop-distance notional caps for Perps and binary Prediction Markets', () => {
    const perpBundle = buildScenarioBundle('sol-perp-breakout');
    const perpSizing = sizePositionByFixedLoss(
      10.0,
      125, // 1.25% stop => $10 / 0.0125 = $800 max notional
      perpBundle.orderbook,
      DEFAULT_SOLANA_RISK_CONFIG
    );
    expect(perpSizing.fixedRiskCapUsdc).toBe(10.0);
    expect(perpSizing.rawRiskSizedNotionalUsdc).toBe(800.0);
    expect(perpSizing.finalSizedNotionalUsdc).toBe(800.0);
    expect(perpSizing.impliedMaxLossUsdc).toBeLessThanOrEqual(10.0);

    // Oversized requested stake (e.g. $500) is clamped hard to $10.00 max loss!
    const clampedPerp = sizePositionByFixedLoss(
      500.0,
      200, // 2.00% stop => $10 / 0.02 = $500 notional
      perpBundle.orderbook,
      DEFAULT_SOLANA_RISK_CONFIG
    );
    expect(clampedPerp.fixedRiskCapUsdc).toBe(10.0);
    expect(clampedPerp.finalSizedNotionalUsdc).toBe(500.0);
    expect(clampedPerp.impliedMaxLossUsdc).toBe(10.0);

    // Binary Prediction Market: full stake bounded by $10.00 USDC
    const pmBundle = buildScenarioBundle('pm-clutch-repricing');
    const pmSizing = sizePositionByFixedLoss(
      50.0,
      10_000,
      pmBundle.orderbook,
      DEFAULT_SOLANA_RISK_CONFIG
    );
    expect(pmSizing.fixedRiskCapUsdc).toBe(10.0);
    expect(pmSizing.finalSizedNotionalUsdc).toBe(10.0);
    expect(pmSizing.impliedMaxLossUsdc).toBe(10.0);
  });

  it('fails closed on NaN, Infinity, zero, and negative inputs with zero NaN leakage', () => {
    const valid = buildScenarioBundle('sol-perp-breakout');
    for (const badStake of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -25]) {
      const dec = evaluateSolanaRiskGate(
        valid.impulse,
        valid.pythFeed,
        valid.orderbook,
        badStake
      );
      expect(dec.passed).toBe(false);
      expect(dec.rejectionCode).toBe('RISK_CAP_VIOLATION');
      expect(Number.isFinite(dec.edgeBps)).toBe(true);
      expect(Number.isFinite(dec.expectedValueUsdc)).toBe(true);
      expect(Number.isFinite(dec.sizing.finalSizedNotionalUsdc)).toBe(true);
      expect(dec.sizing.finalSizedNotionalUsdc).toBe(0);
    }
  });

  it('evaluates all 6 canonical scenarios to their exact expected pass/rejection codes', () => {
    const nowMs = Date.now();
    const results = Object.fromEntries(
      ALL_SCENARIO_IDS.map((id) => {
        const b = buildScenarioBundle(id, undefined, nowMs);
        const d = evaluateSolanaRiskGate(b.impulse, b.pythFeed, b.orderbook, 10.0, DEFAULT_SOLANA_RISK_CONFIG, nowMs);
        return [id, d];
      })
    );

    expect(results['sol-perp-breakout'].passed).toBe(true);
    expect(results['sol-perp-breakout'].rejectionCode).toBe('NONE');

    expect(results['pm-clutch-repricing'].passed).toBe(true);
    expect(results['pm-clutch-repricing'].rejectionCode).toBe('NONE');

    expect(results['btc-cpi-conf-blowout'].passed).toBe(false);
    expect(results['btc-cpi-conf-blowout'].rejectionCode).toBe('ORACLE_CONFIDENCE_TOO_WIDE');

    expect(results['eth-stale-oracle-trap'].passed).toBe(false);
    expect(results['eth-stale-oracle-trap'].rejectionCode).toBe('ORACLE_STALE_FRAME');

    expect(results['pm-thin-depth-trap'].passed).toBe(false);
    expect(results['pm-thin-depth-trap'].rejectionCode).toBe('INSUFFICIENT_DEPTH');

    expect(results['sol-adverse-whale-trap'].passed).toBe(false);
    expect(results['sol-adverse-whale-trap'].rejectionCode).toBe('WHALE_TOXICITY_ALERT');
  });

  it('simulates multi-rung VWAP slippage accurately', () => {
    const sim = simulateOrderbookVwapFill(
      [
        { price: 100.0, sizeBase: 2, notionalUsdc: 200 },
        { price: 100.2, sizeBase: 3, notionalUsdc: 300.6 },
      ],
      400,
      100.25
    );
    expect(sim.filledNotionalUsdc).toBe(400);
    expect(sim.vwapPrice).toBeGreaterThan(100.0);
    expect(sim.vwapPrice).toBeLessThan(100.2);
    expect(sim.fullyFilled).toBe(true);
  });
});
