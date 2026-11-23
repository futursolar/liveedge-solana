import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOLANA_RISK_CONFIG,
  evaluateSolanaRiskGate,
  sizePositionByFixedLoss,
} from '../src/engine/solanaRiskGate';
import {
  DEFAULT_PYTH_SOLANA_DEVNET_RPC,
  PYTH_CANONICAL_FEEDS,
  decodePythPriceUpdateV2,
  evaluatePythOracleGuard,
  fetchLivePythFeeds,
} from '../src/oracle/pythHermesGuard';
import {
  ALL_SCENARIO_IDS,
  DRIFT_CANONICAL_MARKETS,
  buildL2LadderAroundMid,
  buildScenarioBundle,
  fetchLiveDriftPerpMarkets,
  simulateOrderbookVwapFill,
} from '../src/venues/marketDataClient';

function hexToUint8(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

// Authentic 134-byte Pyth Solana Receiver `PriceUpdateV2` hex vector (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`)
const REAL_SOL_PRICE_UPDATE_V2_HEX =
  '22f123639d7ef4cd60314704340deddf371fd42472148f248e9d1a6d1a5eb2ac3acd8b7fd5d6b24301ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56dede796bb01000000a575220000000000f8ffffff3b75046b000000003a75046b00000000bc920abe010000001cbc22000000000088c3311c0000000000';

describe('Pyth PriceUpdateV2 Binary Decoder & Confidence/Staleness/Verification Guard', () => {
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
    expect(snapshot.verificationLevel).toBe('FULL');
    expect(snapshot.cluster).toBe('devnet');
    expect(snapshot.priceUsd).toBeCloseTo(74.421965, 5);
    expect(snapshot.confUsd).toBeCloseTo(0.022583, 5);
    expect(snapshot.confBps).toBeCloseTo(3.03, 1);
    expect(snapshot.ageMs).toBe(8000);
    expect(snapshot.postedSlot).toBe(473023368);

    const verdict = evaluatePythOracleGuard(snapshot, 45_000, 30);
    expect(verdict.passed).toBe(true);
    expect(verdict.rejectionCode).toBe('NONE');
  });

  it('rejects corrupted discriminator, invalid verification tag, Partial guardian quorum, stale frames, and wide confidence', () => {
    const badBytes = hexToUint8(REAL_SOL_PRICE_UPDATE_V2_HEX);
    badBytes[0] = 0xff;
    expect(() =>
      decodePythPriceUpdateV2(badBytes, '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE')
    ).toThrow(/discriminator/i);

    const invalidTagBytes = hexToUint8(REAL_SOL_PRICE_UPDATE_V2_HEX);
    invalidTagBytes[40] = 2;
    expect(() =>
      decodePythPriceUpdateV2(
        invalidTagBytes,
        '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE'
      )
    ).toThrow(/verification tag/i);

    const staleBundle = buildScenarioBundle('eth-stale-oracle-trap');
    const staleVerdict = evaluatePythOracleGuard(staleBundle.pythFeed, 45_000, 30);
    expect(staleVerdict.passed).toBe(false);
    expect(staleVerdict.rejectionCode).toBe('ORACLE_STALE_FRAME');

    const partialFeed = {
      ...buildScenarioBundle('sol-perp-breakout').pythFeed,
      verificationLevel: 'PARTIAL' as const,
    };
    const partialVerdict = evaluatePythOracleGuard(partialFeed, 45_000, 30);
    expect(partialVerdict.passed).toBe(false);
    expect(partialVerdict.reason).toContain('Partial');

    const wideConfBundle = buildScenarioBundle('btc-cpi-conf-blowout');
    const wideVerdict = evaluatePythOracleGuard(wideConfBundle.pythFeed, 45_000, 30);
    expect(wideVerdict.passed).toBe(false);
    expect(wideVerdict.rejectionCode).toBe('ORACLE_CONFIDENCE_TOO_WIDE');
  });

  it('defaults fetchLivePythFeeds to Solana Devnet RPC and preserves distinct Drift Devnet oracle PDAs', async () => {
    expect(DEFAULT_PYTH_SOLANA_DEVNET_RPC).toBe('https://api.devnet.solana.com');
    const bundle = buildScenarioBundle('sol-perp-breakout');
    expect(bundle.pythFeed.priceUpdateAccount).toBe(
      PYTH_CANONICAL_FEEDS.SOL.solanaPriceUpdateAccount
    );
    expect(bundle.orderbook.oraclePubkey).toBe(
      DRIFT_CANONICAL_MARKETS['SOL-PERP'].oraclePubkey
    );
    expect(bundle.orderbook.oraclePubkey).not.toBe(
      bundle.pythFeed.priceUpdateAccount
    );

    const calledUrls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calledUrls.push(String(url));
      return { ok: false, status: 503, json: async () => ({}) };
    }) as unknown as typeof fetch;

    try {
      const fallbackFeeds = await fetchLivePythFeeds({
        includeCoinbaseSpot: false,
      });
      expect(calledUrls[0]).toBe('https://api.devnet.solana.com');
      expect(fallbackFeeds.SOL.cluster).toBe('devnet');
      expect(fallbackFeeds.SOL.postedSlot).toBeGreaterThan(500_000_000);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('Fixed-Loss Position Sizer & 8-Gate Fail-Closed Solana Risk Engine', () => {
  it('computes exact stop-distance notional caps for LONG Perps, SHORT Perps, and binary Prediction Markets', () => {
    const perpBundle = buildScenarioBundle('sol-perp-breakout');
    const perpSizing = sizePositionByFixedLoss(
      10.0,
      125, // 1.25% stop => $10 / 0.0125 = $800 max notional
      perpBundle.orderbook,
      DEFAULT_SOLANA_RISK_CONFIG,
      'LONG'
    );
    expect(perpSizing.fixedRiskCapUsdc).toBe(10.0);
    expect(perpSizing.rawRiskSizedNotionalUsdc).toBe(800.0);
    expect(perpSizing.finalSizedNotionalUsdc).toBe(800.0);
    expect(perpSizing.impliedMaxLossUsdc).toBeLessThanOrEqual(10.0);

    // SHORT Perp impulse: sweeps bids descending with limitPrice < bestBid and positive EV!
    const nowMs = Date.now();
    const shortImpulse = {
      ...perpBundle.impulse,
      direction: 'SHORT' as const,
      spotMoveBps: -72,
      fairValuePrice: Number((perpBundle.orderbook.bestBid * 0.993).toFixed(4)),
    };
    const shortDecision = evaluateSolanaRiskGate(
      shortImpulse,
      perpBundle.pythFeed,
      perpBundle.orderbook,
      10.0,
      DEFAULT_SOLANA_RISK_CONFIG,
      nowMs
    );
    expect(shortDecision.passed).toBe(true);
    expect(shortDecision.sizing.limitPrice).toBeLessThan(
      perpBundle.orderbook.bestBid
    );
    expect(shortDecision.sizing.finalSizedNotionalUsdc).toBe(800.0);
    expect(shortDecision.edgeBps).toBeGreaterThanOrEqual(35.0);
    expect(shortDecision.expectedValueUsdc).toBeGreaterThan(0);

    // Low-priced Binary Prediction Market (bestAsk = 0.20, 0.5c fill slippage = 50 prob bps <= 150 bps cap)
    const { bids: lowBids } = buildL2LadderAroundMid(
      0.19,
      0.01,
      6.0,
      true
    );
    const pmTemplate = buildScenarioBundle('pm-clutch-repricing', undefined, nowMs);
    const lowPricePmBook = {
      ...pmTemplate.orderbook,
      bids: lowBids,
      asks: [
        { price: 0.2, sizeBase: 25, notionalUsdc: 5.0 },
        { price: 0.21, sizeBase: 150, notionalUsdc: 31.5 },
      ],
      bestBid: 0.18,
      bestAsk: 0.2,
      midPrice: 0.19,
      spread: 0.02,
      spreadBps: 200,
    };
    const lowPricePmImpulse = {
      ...pmTemplate.impulse,
      fairValuePrice: 0.27, // +7.0c (+700 prob bps) edge
    };
    const lowPriceDecision = evaluateSolanaRiskGate(
      lowPricePmImpulse,
      pmTemplate.pythFeed,
      lowPricePmBook,
      10.0,
      DEFAULT_SOLANA_RISK_CONFIG,
      nowMs
    );
    // $5 at 0.20 + $5 at 0.21 => vwap ~ 0.2049 => 0.49c = 49 probability bps (<= 150 bps, NEVER 245 bps!)
    expect(lowPriceDecision.passed).toBe(true);
    expect(lowPriceDecision.sizing.slippageBps).toBeLessThan(60);
    expect(lowPriceDecision.sizing.finalSizedNotionalUsdc).toBe(10.0);
  });

  it('fails closed on NaN, Infinity, zero, and negative inputs with zero NaN leakage', () => {
    const valid = buildScenarioBundle('sol-perp-breakout');
    for (const badStake of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -25,
    ]) {
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
        const d = evaluateSolanaRiskGate(
          b.impulse,
          b.pythFeed,
          b.orderbook,
          10.0,
          DEFAULT_SOLANA_RISK_CONFIG,
          nowMs
        );
        return [id, d];
      })
    );

    expect(results['sol-perp-breakout'].passed).toBe(true);
    expect(results['sol-perp-breakout'].rejectionCode).toBe('NONE');

    expect(results['pm-clutch-repricing'].passed).toBe(true);
    expect(results['pm-clutch-repricing'].rejectionCode).toBe('NONE');

    expect(results['btc-cpi-conf-blowout'].passed).toBe(false);
    expect(results['btc-cpi-conf-blowout'].rejectionCode).toBe(
      'ORACLE_CONFIDENCE_TOO_WIDE'
    );

    expect(results['eth-stale-oracle-trap'].passed).toBe(false);
    expect(results['eth-stale-oracle-trap'].rejectionCode).toBe(
      'ORACLE_STALE_FRAME'
    );

    expect(results['pm-thin-depth-trap'].passed).toBe(false);
    expect(results['pm-thin-depth-trap'].rejectionCode).toBe(
      'INSUFFICIENT_DEPTH'
    );

    expect(results['sol-adverse-whale-trap'].passed).toBe(false);
    expect(results['sol-adverse-whale-trap'].rejectionCode).toBe(
      'WHALE_TOXICITY_ALERT'
    );
  });

  it('simulates multi-rung VWAP slippage accurately on both LONG asks and SHORT bids', () => {
    const longSim = simulateOrderbookVwapFill(
      [
        { price: 100.0, sizeBase: 2, notionalUsdc: 200 },
        { price: 100.2, sizeBase: 3, notionalUsdc: 300.6 },
      ],
      400,
      100.25,
      'LONG',
      false
    );
    expect(longSim.filledNotionalUsdc).toBe(400);
    expect(longSim.vwapPrice).toBeGreaterThan(100.0);
    expect(longSim.vwapPrice).toBeLessThan(100.2);
    expect(longSim.fullyFilled).toBe(true);

    const shortSim = simulateOrderbookVwapFill(
      [
        { price: 100.0, sizeBase: 2, notionalUsdc: 200 },
        { price: 99.8, sizeBase: 3, notionalUsdc: 299.4 },
      ],
      400,
      99.75,
      'SHORT',
      false
    );
    expect(shortSim.filledNotionalUsdc).toBe(400);
    expect(shortSim.vwapPrice).toBeLessThan(100.0);
    expect(shortSim.vwapPrice).toBeGreaterThan(99.8);
    expect(shortSim.fullyFilled).toBe(true);
  });

  it('decodes Drift v2 PerpMarket binary accounts via fetchLiveDriftPerpMarkets', async () => {
    const fakeAcc = new Uint8Array(320);
    const view = new DataView(fakeAcc.buffer);
    view.setBigInt64(72, 80_016_700n, true); // lastOraclePrice = $80.0167
    view.setBigUint64(80, 25_000n, true); // conf = $0.025
    view.setBigInt64(88, 12n, true); // delay = 12 slots
    view.setBigUint64(176, 10_000_000_000_000n, true); // baseReserve = 10,000e9
    view.setBigUint64(192, 10_000_000_000_000n, true); // quoteReserve = 10,000e9
    view.setBigUint64(256, 10_000_000_000_000n, true); // sqrtK = 10,000e9
    view.setBigUint64(272, 80_050_000n, true); // peg = $80.05
    const b64 = Buffer.from(fakeAcc).toString('base64');

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        result: {
          value: [
            { data: [b64, 'base64'] },
            { data: [b64, 'base64'] },
            { data: [b64, 'base64'] },
          ],
        },
      }),
    })) as unknown as typeof fetch;

    try {
      const markets = await fetchLiveDriftPerpMarkets('https://mock.devnet.solana.com');
      expect(markets['SOL-PERP']).toBeDefined();
      expect(markets['SOL-PERP'].reservePriceUsd).toBeCloseTo(80.05, 2);
      expect(markets['SOL-PERP'].sqrtKBase).toBe(10_000);
      expect(markets['SOL-PERP'].lastOracleDelaySlots).toBe(12);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
