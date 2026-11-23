import type {
  ImpulseSignal,
  OrderbookLevel,
  PythFeedSnapshot,
  ScenarioId,
  SupportedAsset,
  TradeDirection,
  VenueKind,
  VenueOrderbookSnapshot,
} from '../engine/types';
import { PYTH_CANONICAL_FEEDS } from '../oracle/pythHermesGuard';

export const DRIFT_V2_PROGRAM_ID =
  'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';

/** Canonical Drift v2 Devnet USDC Quote SpotMarket[0] PDA & Oracle (verified on api.devnet.solana.com) */
export const DRIFT_DEVNET_USDC_SPOT_MARKET_PDA =
  '6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3';
export const DRIFT_DEVNET_USDC_SPOT_ORACLE =
  '9VCioxmni2gDLv11qufWzT3RDERhQE4iY5Gf7NTfYyAV';

export interface DriftMarketMeta {
  marketIndex: number;
  symbol: string;
  title: string;
  asset: SupportedAsset;
  venue: VenueKind;
  marketPda: string;
  oraclePubkey: string;
}

export const DRIFT_CANONICAL_MARKETS: Record<string, DriftMarketMeta> = {
  'SOL-PERP': {
    marketIndex: 0,
    symbol: 'SOL-PERP',
    title: 'Drift v2 Solana Perpetual (SOL-PERP)',
    asset: 'SOL',
    venue: 'SOLANA_DRIFT_PERP',
    marketPda: '8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W',
    oraclePubkey: '3m6i4RFWEDw2Ft4tFHPJtYgmpPe21k56M3FHeWYrgGBz',
  },
  'BTC-PERP': {
    marketIndex: 1,
    symbol: 'BTC-PERP',
    title: 'Drift v2 Bitcoin Perpetual (BTC-PERP)',
    asset: 'BTC',
    venue: 'SOLANA_DRIFT_PERP',
    marketPda: '2UZMvVTBQR9yWxrEdzEQzXWE61bUjqQ5VpJAGqVb3B19',
    oraclePubkey: '35MbvS1Juz2wf7GsyHrkCw8yfKciRLxVpEhfZDZFrB4R',
  },
  'ETH-PERP': {
    marketIndex: 2,
    symbol: 'ETH-PERP',
    title: 'Drift v2 Ethereum Perpetual (ETH-PERP)',
    asset: 'ETH',
    venue: 'SOLANA_DRIFT_PERP',
    marketPda: '25Eax9W8SA3wpCQFhJEGyHhQ2NDHEshZEDzyMNtthR8D',
    oraclePubkey: '93FG52TzNKCnMiasV14Ba34BYcHDb9p4zK4GjZnLwqWR',
  },
  'SOL-80-DEC-BET': {
    marketIndex: 26,
    symbol: 'SOL-80-DEC-BET',
    title: 'Drift v2 Devnet BET Prediction Market (#26 Binary Contract)',
    asset: 'SOL',
    venue: 'SOLANA_DRIFT_BET_PM',
    marketPda: '7rUSt1PXXn2Pp4ZNDcZqZGEgKSGpxqbRyb2W6rG1Dtt6',
    oraclePubkey: '3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA',
  },
};

function readU128LE(view: DataView, offset: number): bigint {
  const lo = view.getBigUint64(offset, true);
  const hi = view.getBigUint64(offset + 8, true);
  return (hi << 64n) | lo;
}

export interface DecodedDriftPerpState {
  marketPda: string;
  lastOraclePriceUsd: number;
  lastOracleConfUsd: number;
  lastOracleDelaySlots: number;
  reservePriceUsd: number;
  sqrtKBase: number;
  pegMultiplier: number;
}

/**
 * Decodes Drift v2 `PerpMarket` zero-copy account bytes (`dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`)
 * to extract AMM `x * y = k` reserves, `peg_multiplier`, and `historical_oracle_data`.
 */
export function decodeDriftPerpMarketAccount(
  rawBytes: Uint8Array,
  marketPda: string
): DecodedDriftPerpState {
  if (rawBytes.length < 300) {
    throw new Error(`Invalid Drift PerpMarket account size (${rawBytes.length})`);
  }
  const view = new DataView(
    rawBytes.buffer,
    rawBytes.byteOffset,
    rawBytes.byteLength
  );
  const lastOraclePriceUsd = Number(view.getBigInt64(72, true)) / 1e6;
  const lastOracleConfUsd = Number(view.getBigUint64(80, true)) / 1e6;
  const lastOracleDelaySlots = Number(view.getBigInt64(88, true));
  const baseAssetReserve = Number(readU128LE(view, 176)) / 1e9;
  const quoteAssetReserve = Number(readU128LE(view, 192)) / 1e9;
  const sqrtKBase = Number(readU128LE(view, 256)) / 1e9;
  const pegMultiplier = Number(readU128LE(view, 272)) / 1e6;
  const reservePriceUsd =
    baseAssetReserve > 0
      ? (quoteAssetReserve * pegMultiplier) / baseAssetReserve
      : lastOraclePriceUsd;

  return {
    marketPda,
    lastOraclePriceUsd: Number(lastOraclePriceUsd.toFixed(4)),
    lastOracleConfUsd: Number(lastOracleConfUsd.toFixed(4)),
    lastOracleDelaySlots,
    reservePriceUsd: Number(reservePriceUsd.toFixed(4)),
    sqrtKBase: Number(sqrtKBase.toFixed(2)),
    pegMultiplier: Number(pegMultiplier.toFixed(4)),
  };
}

function base64ToUint8(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return arr;
}

/**
 * Queries live Drift v2 `PerpMarket` PDAs (`SOL-PERP`, `BTC-PERP`, `ETH-PERP`) directly
 * from Solana RPC (`dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`) and decodes vAMM
 * reserves, `peg_multiplier`, and `last_oracle_delay` slots.
 */
export async function fetchLiveDriftPerpMarkets(
  rpcUrl = 'https://api.devnet.solana.com',
  timeoutMs = 4000
): Promise<Record<string, DecodedDriftPerpState>> {
  const symbols = ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'] as const;
  const pdas = symbols.map((s) => DRIFT_CANONICAL_MARKETS[s].marketPda);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getMultipleAccounts',
        params: [pdas, { encoding: 'base64' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return {};
    const body = (await res.json()) as {
      result?: { value?: Array<{ data?: [string, string] } | null> };
    };
    const values = body.result?.value || [];
    const out: Record<string, DecodedDriftPerpState> = {};
    symbols.forEach((sym, idx) => {
      const b64 = values[idx]?.data?.[0];
      if (b64) {
        try {
          out[sym] = decodeDriftPerpMarketAccount(
            base64ToUint8(b64),
            DRIFT_CANONICAL_MARKETS[sym].marketPda
          );
        } catch {
          // Skip malformed account entry
        }
      }
    });
    return out;
  } catch {
    return {};
  }
}

export function buildL2LadderAroundMid(
  midPrice: number,
  halfSpreadRatio: number,
  topRungNotionalUsdc: number,
  isPredictionProb = false
): { bids: OrderbookLevel[]; asks: OrderbookLevel[] } {
  const stepRatios = [0, 0.0005, 0.0012, 0.0022, 0.0038];
  const sizeMultipliers = [1.0, 1.45, 2.1, 2.8, 3.6];
  const bids: OrderbookLevel[] = [];
  const asks: OrderbookLevel[] = [];

  for (let i = 0; i < stepRatios.length; i++) {
    const rawBid = isPredictionProb
      ? Math.max(0.01, Math.min(0.98, midPrice - halfSpreadRatio - i * 0.01))
      : Math.max(0.01, midPrice * (1 - halfSpreadRatio - stepRatios[i]));
    const rawAsk = isPredictionProb
      ? Math.max(0.02, Math.min(0.99, midPrice + halfSpreadRatio + i * 0.01))
      : Math.max(0.02, midPrice * (1 + halfSpreadRatio + stepRatios[i]));

    const decimals = isPredictionProb || midPrice < 10 ? 4 : 2;
    const bidPrice = Number(rawBid.toFixed(decimals));
    const askPrice = Number(rawAsk.toFixed(decimals));
    const notional = Number((topRungNotionalUsdc * sizeMultipliers[i]).toFixed(2));

    bids.push({
      price: bidPrice,
      sizeBase: Number((notional / bidPrice).toFixed(4)),
      notionalUsdc: notional,
    });
    asks.push({
      price: askPrice,
      sizeBase: Number((notional / askPrice).toFixed(4)),
      notionalUsdc: notional,
    });
  }

  return { bids, asks };
}

export function computeExecutableDepthUsdc(
  levels: OrderbookLevel[],
  limitPrice: number,
  direction: TradeDirection = 'LONG'
): number {
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) return 0;
  const isShort = direction === 'SHORT';
  let total = 0;
  for (const level of levels) {
    if (
      Number.isFinite(level.price) &&
      Number.isFinite(level.notionalUsdc) &&
      level.price > 0 &&
      level.notionalUsdc > 0
    ) {
      const withinBound = isShort
        ? level.price >= limitPrice - 1e-9
        : level.price <= limitPrice + 1e-9;
      if (withinBound) {
        total += level.notionalUsdc;
      }
    }
  }
  return Number(total.toFixed(2));
}

export interface VwapExecutionSim {
  filledNotionalUsdc: number;
  filledBaseQty: number;
  vwapPrice: number;
  slippageBps: number;
  fullyFilled: boolean;
}

/**
 * Simulates multi-rung VWAP execution across asks (`LONG`/`YES`) or bids (`SHORT`).
 * - For Perps (`isPredictionProb = false`): `slippageBps` is relative basis points vs `bestAsk` / `bestBid`.
 * - For Binary Prediction Markets (`isPredictionProb = true`): `slippageBps` is probability basis points
 *   (`1 cent = $0.01 = 100 bps`), matching `maxSlippageBps = 150` (`1.5c`) across all probability levels.
 */
export function simulateOrderbookVwapFill(
  levels: OrderbookLevel[],
  targetNotionalUsdc: number,
  limitPrice: number,
  direction: TradeDirection = 'LONG',
  isPredictionProb = false
): VwapExecutionSim {
  if (
    !Number.isFinite(targetNotionalUsdc) ||
    targetNotionalUsdc <= 0 ||
    !Number.isFinite(limitPrice) ||
    limitPrice <= 0 ||
    levels.length === 0
  ) {
    return {
      filledNotionalUsdc: 0,
      filledBaseQty: 0,
      vwapPrice: 0,
      slippageBps: 0,
      fullyFilled: false,
    };
  }

  const isShort = direction === 'SHORT';
  const sortedLevels = [...levels]
    .filter((a) => Number.isFinite(a.price) && a.price > 0 && a.notionalUsdc > 0)
    .sort((a, b) => (isShort ? b.price - a.price : a.price - b.price));

  if (sortedLevels.length === 0) {
    return {
      filledNotionalUsdc: 0,
      filledBaseQty: 0,
      vwapPrice: 0,
      slippageBps: 0,
      fullyFilled: false,
    };
  }

  const bestRef = sortedLevels[0].price;
  let remainingUsdc = targetNotionalUsdc;
  let filledUsdc = 0;
  let filledBase = 0;

  for (const rung of sortedLevels) {
    const outOfBounds = isShort
      ? rung.price < limitPrice - 1e-9
      : rung.price > limitPrice + 1e-9;
    if (outOfBounds || remainingUsdc <= 1e-6) break;
    const takeUsdc = Math.min(remainingUsdc, rung.notionalUsdc);
    filledUsdc += takeUsdc;
    filledBase += takeUsdc / rung.price;
    remainingUsdc -= takeUsdc;
  }

  if (filledUsdc <= 0 || filledBase <= 0) {
    return {
      filledNotionalUsdc: 0,
      filledBaseQty: 0,
      vwapPrice: 0,
      slippageBps: 0,
      fullyFilled: false,
    };
  }

  const vwapPrice = filledUsdc / filledBase;
  const adverseDelta = isShort ? bestRef - vwapPrice : vwapPrice - bestRef;
  const slippageBps =
    bestRef > 0
      ? isPredictionProb
        ? Math.max(0, Number((adverseDelta * 10_000).toFixed(2)))
        : Math.max(0, Number(((adverseDelta / bestRef) * 10_000).toFixed(2)))
      : 0;

  return {
    filledNotionalUsdc: Number(filledUsdc.toFixed(2)),
    filledBaseQty: Number(filledBase.toFixed(4)),
    vwapPrice: Number(vwapPrice.toFixed(4)),
    slippageBps,
    fullyFilled: remainingUsdc <= 0.05,
  };
}

export interface ScenarioBundle {
  scenarioId: ScenarioId;
  badge: string;
  expectedOutcome: 'PASS' | 'BLOCK';
  pythFeed: PythFeedSnapshot;
  orderbook: VenueOrderbookSnapshot;
  impulse: ImpulseSignal;
}

/**
 * Materializes deterministic or live-anchored Devnet scenarios demonstrating every
 * Solana risk-gate path: valid sub-second impulse execution vs stale oracle,
 * wide Pyth confidence blowout, thin prediction-market book, and whale counter-sweeps.
 */
export function buildScenarioBundle(
  scenarioId: ScenarioId,
  liveFeeds?: Partial<Record<SupportedAsset, PythFeedSnapshot>>,
  nowMs = Date.now(),
  devnetSlot = 525_528_300
): ScenarioBundle {
  const baseSolPrice =
    liveFeeds?.SOL && liveFeeds.SOL.priceUsd > 5
      ? liveFeeds.SOL.priceUsd
      : PYTH_CANONICAL_FEEDS.SOL.fallbackPriceUsd;
  const baseBtcPrice =
    liveFeeds?.BTC && liveFeeds.BTC.priceUsd > 1000
      ? liveFeeds.BTC.priceUsd
      : PYTH_CANONICAL_FEEDS.BTC.fallbackPriceUsd;
  const baseEthPrice =
    liveFeeds?.ETH && liveFeeds.ETH.priceUsd > 100
      ? liveFeeds.ETH.priceUsd
      : PYTH_CANONICAL_FEEDS.ETH.fallbackPriceUsd;

  if (scenarioId === 'sol-perp-breakout') {
    const pythPrice = Number(baseSolPrice.toFixed(4));
    const confUsd = Number((pythPrice * 0.00028).toFixed(4)); // 2.8 bps tight conf
    const spotImpulse = Number((pythPrice * 1.0068).toFixed(4)); // +68 bps spot lead
    const { bids, asks } = buildL2LadderAroundMid(pythPrice * 1.0005, 0.0004, 650);
    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    return {
      scenarioId,
      badge: 'SOL-PERP · IMPULSE PASS',
      expectedOutcome: 'PASS',
      pythFeed: {
        asset: 'SOL',
        symbol: 'SOL/USD',
        feedIdHex: PYTH_CANONICAL_FEEDS.SOL.feedIdHex,
        priceUpdateAccount: PYTH_CANONICAL_FEEDS.SOL.solanaPriceUpdateAccount,
        priceUsd: pythPrice,
        confUsd,
        confBps: 2.8,
        emaPriceUsd: Number((pythPrice * 0.9985).toFixed(4)),
        exponent: -8,
        publishTimeSec: Math.floor((nowMs - 1200) / 1000),
        ageMs: 1200,
        postedSlot: devnetSlot - 2,
        spotReferenceUsd: spotImpulse,
        spotDislocationBps: 68.0,
        source: liveFeeds?.SOL?.source ?? 'SOLANA_ONCHAIN_RECEIVER',
        cluster: 'devnet',
        verificationLevel: 'FULL',
      },
      orderbook: {
        marketId: 'drift-sol-perp-0',
        symbol: 'SOL-PERP',
        title: DRIFT_CANONICAL_MARKETS['SOL-PERP'].title,
        venue: 'SOLANA_DRIFT_PERP',
        asset: 'SOL',
        marketIndex: 0,
        marketPda: DRIFT_CANONICAL_MARKETS['SOL-PERP'].marketPda,
        oraclePubkey: DRIFT_CANONICAL_MARKETS['SOL-PERP'].oraclePubkey,
        bestBid,
        bestAsk,
        midPrice: Number(((bestBid + bestAsk) / 2).toFixed(4)),
        spread: Number((bestAsk - bestBid).toFixed(4)),
        spreadBps: Number((((bestAsk - bestBid) / bestAsk) * 10_000).toFixed(2)),
        bids,
        asks,
        executableAskDepthUsdc: computeExecutableDepthUsdc(asks, bestAsk * 1.002),
        adverseWhaleFlowUsdc: 120,
        fetchedAtMs: nowMs - 180,
        slot: devnetSlot,
        sourceLabel: 'DRIFT_DEVNET_VAMM + PYTH_RECEIVER',
      },
      impulse: {
        id: 'imp-sol-breakout',
        scenarioId,
        title: 'SOL Spot L2 Sweep (+68 bps) vs Lagging Drift Perp Ask',
        category: 'PERP_BREAKOUT',
        venue: 'SOLANA_DRIFT_PERP',
        asset: 'SOL',
        marketSymbol: 'SOL-PERP',
        direction: 'LONG',
        spotMoveBps: 68,
        fairValuePrice: spotImpulse,
        stopDistanceBps: 125, // 1.25% invalidation stop => $10 risk = $800 max notional
        cuiBonoSafe: true,
        adverseWhaleFlowUsdc: 120,
        detectedAtMs: nowMs - 95,
        narrative:
          'Coinbase & Solana DEX spot sweep +68 bps while Pyth ±conf stays tight at 2.8 bps (1.2s fresh). Fixed $10 max-loss sizer caps SOL-PERP IOC limit order cleanly.',
      },
    };
  }

  if (scenarioId === 'btc-cpi-conf-blowout') {
    const pythPrice = Number(baseBtcPrice.toFixed(2));
    const confUsd = Number((pythPrice * 0.00485).toFixed(2)); // 48.5 bps > 30 bps limit!
    const { bids, asks } = buildL2LadderAroundMid(pythPrice, 0.0006, 1200);
    return {
      scenarioId,
      badge: 'BTC-PERP · CONF BLOWOUT BLOCK',
      expectedOutcome: 'BLOCK',
      pythFeed: {
        asset: 'BTC',
        symbol: 'BTC/USD',
        feedIdHex: PYTH_CANONICAL_FEEDS.BTC.feedIdHex,
        priceUpdateAccount: PYTH_CANONICAL_FEEDS.BTC.solanaPriceUpdateAccount,
        priceUsd: pythPrice,
        confUsd,
        confBps: 48.5,
        emaPriceUsd: pythPrice,
        exponent: -8,
        publishTimeSec: Math.floor((nowMs - 900) / 1000),
        ageMs: 900,
        postedSlot: devnetSlot - 1,
        spotReferenceUsd: Number((pythPrice * 1.008).toFixed(2)),
        spotDislocationBps: 80.0,
        source: 'SOLANA_ONCHAIN_RECEIVER',
        cluster: 'devnet',
        verificationLevel: 'FULL',
      },
      orderbook: {
        marketId: 'drift-btc-perp-1',
        symbol: 'BTC-PERP',
        title: DRIFT_CANONICAL_MARKETS['BTC-PERP'].title,
        venue: 'SOLANA_DRIFT_PERP',
        asset: 'BTC',
        marketIndex: 1,
        marketPda: DRIFT_CANONICAL_MARKETS['BTC-PERP'].marketPda,
        oraclePubkey: DRIFT_CANONICAL_MARKETS['BTC-PERP'].oraclePubkey,
        bestBid: bids[0].price,
        bestAsk: asks[0].price,
        midPrice: pythPrice,
        spread: Number((asks[0].price - bids[0].price).toFixed(2)),
        spreadBps: Number(
          (((asks[0].price - bids[0].price) / asks[0].price) * 10_000).toFixed(2)
        ),
        bids,
        asks,
        executableAskDepthUsdc: computeExecutableDepthUsdc(
          asks,
          asks[0].price * 1.002
        ),
        adverseWhaleFlowUsdc: 180,
        fetchedAtMs: nowMs - 150,
        slot: devnetSlot,
        sourceLabel: 'DRIFT_DEVNET_VAMM + PYTH_RECEIVER',
      },
      impulse: {
        id: 'imp-btc-cpi-conf',
        scenarioId,
        title: 'Macro CPI Print Whipsaw — Pyth Publisher Dispersion 48.5 bps',
        category: 'ORACLE_TRAP',
        venue: 'SOLANA_DRIFT_PERP',
        asset: 'BTC',
        marketSymbol: 'BTC-PERP',
        direction: 'LONG',
        spotMoveBps: 80,
        fairValuePrice: Number((pythPrice * 1.008).toFixed(2)),
        stopDistanceBps: 150,
        cuiBonoSafe: true,
        adverseWhaleFlowUsdc: 180,
        detectedAtMs: nowMs - 80,
        narrative:
          'Headline CPI shock widens Pyth publisher ±conf to 48.5 bps (> 30 bps ceiling). Naive bots get liquidated on oracle snapback; LiveEdge blocks execution.',
      },
    };
  }

  if (scenarioId === 'eth-stale-oracle-trap') {
    const pythPrice = Number(baseEthPrice.toFixed(2));
    const confUsd = Number((pythPrice * 0.0009).toFixed(2));
    const staleAgeMs = 128_000; // 128s stale static push shard!
    const { bids, asks } = buildL2LadderAroundMid(pythPrice, 0.0005, 900);
    return {
      scenarioId,
      badge: 'ETH-PERP · STALE ORACLE BLOCK',
      expectedOutcome: 'BLOCK',
      pythFeed: {
        asset: 'ETH',
        symbol: 'ETH/USD',
        feedIdHex: PYTH_CANONICAL_FEEDS.ETH.feedIdHex,
        priceUpdateAccount: PYTH_CANONICAL_FEEDS.ETH.solanaPriceUpdateAccount,
        priceUsd: pythPrice,
        confUsd,
        confBps: 9.0,
        emaPriceUsd: pythPrice,
        exponent: -8,
        publishTimeSec: Math.floor((nowMs - staleAgeMs) / 1000),
        ageMs: staleAgeMs,
        postedSlot: devnetSlot - 310,
        spotReferenceUsd: Number((pythPrice * 1.0075).toFixed(2)),
        spotDislocationBps: 75.0,
        source: 'SOLANA_ONCHAIN_RECEIVER',
        cluster: 'devnet',
        verificationLevel: 'FULL',
      },
      orderbook: {
        marketId: 'drift-eth-perp-2',
        symbol: 'ETH-PERP',
        title: DRIFT_CANONICAL_MARKETS['ETH-PERP'].title,
        venue: 'SOLANA_DRIFT_PERP',
        asset: 'ETH',
        marketIndex: 2,
        marketPda: DRIFT_CANONICAL_MARKETS['ETH-PERP'].marketPda,
        oraclePubkey: DRIFT_CANONICAL_MARKETS['ETH-PERP'].oraclePubkey,
        bestBid: bids[0].price,
        bestAsk: asks[0].price,
        midPrice: pythPrice,
        spread: Number((asks[0].price - bids[0].price).toFixed(2)),
        spreadBps: Number(
          (((asks[0].price - bids[0].price) / asks[0].price) * 10_000).toFixed(2)
        ),
        bids,
        asks,
        executableAskDepthUsdc: computeExecutableDepthUsdc(
          asks,
          asks[0].price * 1.002
        ),
        adverseWhaleFlowUsdc: 90,
        fetchedAtMs: nowMs - 200,
        slot: devnetSlot,
        sourceLabel: 'DRIFT_DEVNET_VAMM + STATIC_SHARD0',
      },
      impulse: {
        id: 'imp-eth-stale',
        scenarioId,
        title: 'Uncranked Static Push Shard Lag (128.0s Stale Frame)',
        category: 'ORACLE_TRAP',
        venue: 'SOLANA_DRIFT_PERP',
        asset: 'ETH',
        marketSymbol: 'ETH-PERP',
        direction: 'LONG',
        spotMoveBps: 75,
        fairValuePrice: Number((pythPrice * 1.0075).toFixed(2)),
        stopDistanceBps: 125,
        cuiBonoSafe: true,
        adverseWhaleFlowUsdc: 90,
        detectedAtMs: nowMs - 110,
        narrative:
          'Static ETH PriceUpdateV2 shard has not cranked for 128s (> 45s SLA), creating a phantom dislocation illusion. Fail-closed staleness guard aborts tx.',
      },
    };
  }

  if (scenarioId === 'pm-thin-depth-trap') {
    const pythPrice = Number(baseSolPrice.toFixed(4));
    const { bids, asks } = buildL2LadderAroundMid(0.54, 0.01, 4.5, true); // Thin book: top rungs < $25!
    return {
      scenarioId,
      badge: 'SOL-BET PM · THIN BOOK BLOCK',
      expectedOutcome: 'BLOCK',
      pythFeed: {
        asset: 'SOL',
        symbol: 'SOL/USD',
        feedIdHex: PYTH_CANONICAL_FEEDS.SOL.feedIdHex,
        priceUpdateAccount: PYTH_CANONICAL_FEEDS.SOL.solanaPriceUpdateAccount,
        priceUsd: pythPrice,
        confUsd: Number((pythPrice * 0.0003).toFixed(4)),
        confBps: 3.0,
        emaPriceUsd: pythPrice,
        exponent: -8,
        publishTimeSec: Math.floor((nowMs - 1500) / 1000),
        ageMs: 1500,
        postedSlot: devnetSlot - 3,
        spotReferenceUsd: Number((pythPrice * 1.006).toFixed(4)),
        spotDislocationBps: 60.0,
        source: 'SOLANA_ONCHAIN_RECEIVER',
        cluster: 'devnet',
        verificationLevel: 'FULL',
      },
      orderbook: {
        marketId: 'drift-bet-sol-80',
        symbol: 'SOL-80-DEC-BET',
        title: DRIFT_CANONICAL_MARKETS['SOL-80-DEC-BET'].title,
        venue: 'SOLANA_DRIFT_BET_PM',
        asset: 'SOL',
        marketIndex: 26,
        marketPda: DRIFT_CANONICAL_MARKETS['SOL-80-DEC-BET'].marketPda,
        oraclePubkey: DRIFT_CANONICAL_MARKETS['SOL-80-DEC-BET'].oraclePubkey,
        bestBid: bids[0].price,
        bestAsk: asks[0].price,
        midPrice: 0.54,
        spread: Number((asks[0].price - bids[0].price).toFixed(4)),
        spreadBps: 200,
        bids,
        asks,
        executableAskDepthUsdc: computeExecutableDepthUsdc(asks, 0.565),
        adverseWhaleFlowUsdc: 60,
        fetchedAtMs: nowMs - 140,
        slot: devnetSlot,
        sourceLabel: 'SOLANA_BET_CLOB_L2',
      },
      impulse: {
        id: 'imp-pm-thin',
        scenarioId,
        title: 'Illiquid Prediction Outcome Trap — $11.03 Executable Ask Depth',
        category: 'LIQUIDITY_TRAP',
        venue: 'SOLANA_DRIFT_BET_PM',
        asset: 'SOL',
        marketSymbol: 'SOL-80-DEC-BET',
        direction: 'YES',
        spotMoveBps: 60,
        fairValuePrice: 0.62,
        stopDistanceBps: 10_000, // Binary outcome: full stake bounded by $10 cap
        cuiBonoSafe: true,
        adverseWhaleFlowUsdc: 60,
        detectedAtMs: nowMs - 90,
        narrative:
          'Implied fair probability jumps to 62c vs 55c ask, but executable ask depth within +1.5c slippage cap is only $11.03 (< $25 floor). Blocked before sweeping air.',
      },
    };
  }

  if (scenarioId === 'sol-adverse-whale-trap') {
    const pythPrice = Number(baseSolPrice.toFixed(4));
    const { bids, asks } = buildL2LadderAroundMid(pythPrice, 0.0004, 700);
    return {
      scenarioId,
      badge: 'SOL-PERP · WHALE SWEEP BLOCK',
      expectedOutcome: 'BLOCK',
      pythFeed: {
        asset: 'SOL',
        symbol: 'SOL/USD',
        feedIdHex: PYTH_CANONICAL_FEEDS.SOL.feedIdHex,
        priceUpdateAccount: PYTH_CANONICAL_FEEDS.SOL.solanaPriceUpdateAccount,
        priceUsd: pythPrice,
        confUsd: Number((pythPrice * 0.00029).toFixed(4)),
        confBps: 2.9,
        emaPriceUsd: pythPrice,
        exponent: -8,
        publishTimeSec: Math.floor((nowMs - 1100) / 1000),
        ageMs: 1100,
        postedSlot: devnetSlot - 2,
        spotReferenceUsd: Number((pythPrice * 1.0062).toFixed(4)),
        spotDislocationBps: 62.0,
        source: 'SOLANA_ONCHAIN_RECEIVER',
        cluster: 'devnet',
        verificationLevel: 'FULL',
      },
      orderbook: {
        marketId: 'drift-sol-perp-0',
        symbol: 'SOL-PERP',
        title: DRIFT_CANONICAL_MARKETS['SOL-PERP'].title,
        venue: 'SOLANA_DRIFT_PERP',
        asset: 'SOL',
        marketIndex: 0,
        marketPda: DRIFT_CANONICAL_MARKETS['SOL-PERP'].marketPda,
        oraclePubkey: DRIFT_CANONICAL_MARKETS['SOL-PERP'].oraclePubkey,
        bestBid: bids[0].price,
        bestAsk: asks[0].price,
        midPrice: pythPrice,
        spread: Number((asks[0].price - bids[0].price).toFixed(4)),
        spreadBps: 8.0,
        bids,
        asks,
        executableAskDepthUsdc: computeExecutableDepthUsdc(
          asks,
          asks[0].price * 1.002
        ),
        adverseWhaleFlowUsdc: 2840,
        fetchedAtMs: nowMs - 120,
        slot: devnetSlot,
        sourceLabel: 'DRIFT_DEVNET_VAMM + WHALE_TAPE',
      },
      impulse: {
        id: 'imp-whale-trap',
        scenarioId,
        title: 'Pre-Headline Informed Counter-Whale Dump ($2,840 Short Sweep)',
        category: 'LIQUIDITY_TRAP',
        venue: 'SOLANA_DRIFT_PERP',
        asset: 'SOL',
        marketSymbol: 'SOL-PERP',
        direction: 'LONG',
        spotMoveBps: 62,
        fairValuePrice: Number((pythPrice * 1.0062).toFixed(4)),
        stopDistanceBps: 125,
        cuiBonoSafe: true,
        adverseWhaleFlowUsdc: 2840,
        detectedAtMs: nowMs - 70,
        narrative:
          'Smart-money wallet sweeps $2,840 short into the bid wall ahead of retail breakout momentum (>= $1,000 adverse toxicity cap). Blocked fail-closed.',
      },
    };
  }

  // Default / 6th scenario: 'pm-clutch-repricing' (Prediction Market PASS!)
  const pythPrice = Number(baseSolPrice.toFixed(4));
  const { bids, asks } = buildL2LadderAroundMid(0.53, 0.01, 65, true);
  return {
    scenarioId: 'pm-clutch-repricing',
    badge: 'SOL-BET PM · CLUTCH PASS',
    expectedOutcome: 'PASS',
    pythFeed: {
      asset: 'SOL',
      symbol: 'SOL/USD',
      feedIdHex: PYTH_CANONICAL_FEEDS.SOL.feedIdHex,
      priceUpdateAccount: PYTH_CANONICAL_FEEDS.SOL.solanaPriceUpdateAccount,
      priceUsd: pythPrice,
      confUsd: Number((pythPrice * 0.00027).toFixed(4)),
      confBps: 2.7,
      emaPriceUsd: pythPrice,
      exponent: -8,
      publishTimeSec: Math.floor((nowMs - 1050) / 1000),
      ageMs: 1050,
      postedSlot: devnetSlot - 2,
      spotReferenceUsd: Number((pythPrice * 1.0072).toFixed(4)),
      spotDislocationBps: 72.0,
      source: liveFeeds?.SOL?.source ?? 'SOLANA_ONCHAIN_RECEIVER',
      cluster: 'devnet',
      verificationLevel: 'FULL',
    },
    orderbook: {
      marketId: 'drift-bet-sol-80',
      symbol: 'SOL-80-DEC-BET',
      title: DRIFT_CANONICAL_MARKETS['SOL-80-DEC-BET'].title,
      venue: 'SOLANA_DRIFT_BET_PM',
      asset: 'SOL',
      marketIndex: 26,
      marketPda: DRIFT_CANONICAL_MARKETS['SOL-80-DEC-BET'].marketPda,
      oraclePubkey: DRIFT_CANONICAL_MARKETS['SOL-80-DEC-BET'].oraclePubkey,
      bestBid: bids[0].price,
      bestAsk: asks[0].price,
      midPrice: 0.53,
      spread: Number((asks[0].price - bids[0].price).toFixed(4)),
      spreadBps: 200,
      bids,
      asks,
      executableAskDepthUsdc: computeExecutableDepthUsdc(asks, 0.555),
      adverseWhaleFlowUsdc: 140,
      fetchedAtMs: nowMs - 110,
      slot: devnetSlot,
      sourceLabel: 'SOLANA_BET_CLOB_L2 + PYTH_GUARD',
    },
    impulse: {
      id: 'imp-pm-clutch',
      scenarioId: 'pm-clutch-repricing',
      title: 'Breakout Confirmation — Prediction Outcome YES Lags Spot (+6.8c Edge)',
      category: 'SPORTS_PM',
      venue: 'SOLANA_DRIFT_BET_PM',
      asset: 'SOL',
      marketSymbol: 'SOL-80-DEC-BET',
      direction: 'YES',
      spotMoveBps: 72,
      fairValuePrice: 0.608,
      stopDistanceBps: 10_000,
      cuiBonoSafe: true,
      adverseWhaleFlowUsdc: 140,
      detectedAtMs: nowMs - 65,
      narrative:
        'SOL breaks key resistance with 2.7 bps Pyth confidence while binary YES outcome lags at 54.0c vs 60.8c implied fair value (+6.8c edge, $159 depth, $10.00 hard max loss).',
    },
  };
}

export const ALL_SCENARIO_IDS: ScenarioId[] = [
  'sol-perp-breakout',
  'btc-cpi-conf-blowout',
  'eth-stale-oracle-trap',
  'pm-thin-depth-trap',
  'sol-adverse-whale-trap',
  'pm-clutch-repricing',
];
