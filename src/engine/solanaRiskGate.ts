import type {
  ImpulseSignal,
  PositionSizingBreakdown,
  PythFeedSnapshot,
  SolanaRiskGateConfig,
  SolanaRiskGateDecision,
  TradeDirection,
  VenueOrderbookSnapshot,
} from './types';
import { evaluatePythOracleGuard } from '../oracle/pythHermesGuard';
import {
  computeExecutableDepthUsdc,
  simulateOrderbookVwapFill,
} from '../venues/marketDataClient';

export const DEFAULT_SOLANA_RISK_CONFIG: SolanaRiskGateConfig = {
  fixedRiskCapUsdc: 10.0, // Hard $10.00 USDC max loss per impulse
  maxCollateralUsdc: 160.0, // Max collateral committed per trade
  maxLeverage: 5.0, // Max 5.0x effective leverage on Perps ($800 notional ceiling)
  maxOracleStalenessMs: 45_000, // 45s Pyth staleness ceiling
  maxPythConfBps: 30.0, // 30 bps (0.30%) max Pyth ±conf ratio
  minDislocationEdgeBps: 35.0, // +35 bps min edge for Perps (+450 probability bps / +4.5c for binary PM)
  maxSpreadBps: 35.0, // <= 35 bps spread for Perps (<= 400 probability bps / 4.0c for binary PM)
  minExecutableDepthUsdc: 25.0, // >= $25 USDC executable top-of-book depth
  maxSlippageBps: 20.0, // <= 20 bps VWAP slippage for Perps (<= 150 probability bps / 1.5c for PM)
  maxAdverseWhaleFlowUsdc: 1000.0, // Pre-headline counter-whale toxicity limit
};

function isPredictionVenue(book: VenueOrderbookSnapshot): boolean {
  return (
    book.venue === 'SOLANA_DRIFT_BET_PM' ||
    book.venue === 'POLYMARKET_GAMMA_PM'
  );
}

function floorToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const factor = 10 ** decimals;
  return Math.floor(Number((value * factor).toPrecision(12))) / factor;
}

/**
 * Computes conservative directional limit price (`e6` integer-aligned with `programs/liveedge_risk_guard/src/lib.rs`):
 * - `LONG` / `YES`: rounds DOWN (floors) so `limit_price_e6 <= max_from_ref` never overflows on-chain truncation.
 * - `SHORT`: rounds UP (ceils) so `limit_price_e6 >= min_from_ref` never underflows on-chain truncation.
 */
function computeConservativeLimitPrice(
  refPrice: number,
  maxSlipBps: number,
  isShort: boolean,
  isPm: boolean
): number {
  const refE6 = BigInt(Math.round(refPrice * 1_000_000));
  if (refE6 <= 0n) return 0;

  if (isPm) {
    // 1 probability bps = $0.0001 = 100 in e6 units; match on-chain u16 integer bps floor
    const allowedProbBps = BigInt(
      Math.floor(Number(maxSlipBps.toPrecision(12)))
    );
    const deltaE6 = allowedProbBps * 100n;
    if (isShort) {
      const rawMinE6 = refE6 > deltaE6 ? refE6 - deltaE6 : 10_000n;
      const clampedMinE6 =
        rawMinE6 < 10_000n ? 10_000n : rawMinE6 > 990_000n ? 990_000n : rawMinE6;
      const ceiled4E6 = ((clampedMinE6 + 99n) / 100n) * 100n;
      const finalE6 =
        ceiled4E6 <= refE6 || ceiled4E6 <= 10_000n
          ? ceiled4E6 > 990_000n
            ? 990_000n
            : ceiled4E6
          : clampedMinE6;
      return Number(finalE6) / 1_000_000;
    }
    const rawMaxE6 = refE6 + deltaE6;
    const clampedMaxE6 =
      rawMaxE6 > 990_000n ? 990_000n : rawMaxE6 < 10_000n ? 10_000n : rawMaxE6;
    const floored4E6 = (clampedMaxE6 / 100n) * 100n;
    const finalE6 =
      floored4E6 >= refE6 || floored4E6 >= 990_000n
        ? floored4E6 < 10_000n
          ? 10_000n
          : floored4E6
        : clampedMaxE6;
    return Number(finalE6) / 1_000_000;
  }

  // Perp: align with on-chain `ref_e6 * (10_000 +- slip_bps) / 10_000`
  const slipMilliBps = BigInt(
    Math.floor(Number((maxSlipBps * 1_000).toPrecision(12)))
  );
  if (isShort) {
    const factor =
      slipMilliBps >= 10_000_000n ? 0n : 10_000_000n - slipMilliBps;
    const minLimE6 = (refE6 * factor + 9_999_999n) / 10_000_000n;
    const ceiled4E6 = ((minLimE6 + 99n) / 100n) * 100n;
    const finalE6 = ceiled4E6 <= refE6 ? ceiled4E6 : minLimE6;
    return Number(finalE6 > 0n ? finalE6 : 1n) / 1_000_000;
  }

  const maxLimE6 = (refE6 * (10_000_000n + slipMilliBps)) / 10_000_000n;
  const floored4E6 = (maxLimE6 / 100n) * 100n;
  const finalE6 = floored4E6 >= refE6 ? floored4E6 : maxLimE6;
  return Number(finalE6) / 1_000_000;
}

/**
 * Pure Fixed-Loss Position Sizer ("以损定仓") supporting `LONG`, `SHORT`, and `YES`:
 * - For Solana Perpetuals: `rawNotional = fixedRiskCapUsdc / (stopDistanceBps / 10_000)`,
 *   clamped by `maxCollateralUsdc * maxLeverage` and executable book depth within `limitPrice`
 *   (sweeping `asks` for `LONG` and `bids` for `SHORT`).
 * - For Binary Prediction Markets: `stopDistanceBps = 10_000` (100% binary resolution risk),
 *   so `finalSizedNotionalUsdc <= fixedRiskCapUsdc` ($10.00 USDC hard cap), and slippage is
 *   measured consistently in probability basis points (`1 cent = 100 bps`).
 */
export function sizePositionByFixedLoss(
  requestedRiskUsdc: number,
  stopDistanceBps: number,
  book: VenueOrderbookSnapshot,
  config: SolanaRiskGateConfig = DEFAULT_SOLANA_RISK_CONFIG,
  direction: TradeDirection = 'LONG'
): PositionSizingBreakdown {
  const isShort = direction === 'SHORT';
  const refPrice = isShort ? book.bestBid : book.bestAsk;

  const validInputs =
    Number.isFinite(requestedRiskUsdc) &&
    requestedRiskUsdc > 0 &&
    Number.isFinite(stopDistanceBps) &&
    stopDistanceBps >= 25 &&
    stopDistanceBps <= 10_000 &&
    Number.isFinite(refPrice) &&
    refPrice > 0 &&
    Number.isFinite(config.fixedRiskCapUsdc) &&
    config.fixedRiskCapUsdc > 0 &&
    Number.isFinite(config.maxCollateralUsdc) &&
    config.maxCollateralUsdc > 0 &&
    Number.isFinite(config.maxLeverage) &&
    config.maxLeverage > 0 &&
    Number.isFinite(config.maxSlippageBps) &&
    config.maxSlippageBps > 0;

  if (!validInputs) {
    return {
      fixedRiskCapUsdc: 0,
      stopDistanceBps: 0,
      rawRiskSizedNotionalUsdc: 0,
      leverageCappedNotionalUsdc: 0,
      depthCappedNotionalUsdc: 0,
      finalSizedNotionalUsdc: 0,
      finalBaseQty: 0,
      impliedMaxLossUsdc: 0,
      effectiveLeverage: 0,
      vwapFillPrice: 0,
      limitPrice: 0,
      slippageBps: 0,
    };
  }

  const isPm = isPredictionVenue(book);
  const clampedRiskBudgetUsdc = floorToDecimals(
    Math.min(requestedRiskUsdc, config.fixedRiskCapUsdc),
    2
  );
  const effectiveStopBps = isPm
    ? 10_000
    : Math.ceil(Number(stopDistanceBps.toPrecision(12)));
  const maxSlipBps = isPm
    ? Math.max(config.maxSlippageBps, 150)
    : config.maxSlippageBps;

  const limitPrice = computeConservativeLimitPrice(
    refPrice,
    maxSlipBps,
    isShort,
    isPm
  );

  // Strictly floor notional in exact e6 integer arithmetic so `notional_e6 * stop_bps <= cap_e6 * 10_000`
  const budgetE6 = BigInt(Math.round(clampedRiskBudgetUsdc * 1_000_000));
  const maxRawNotionalE6 = (budgetE6 * 10_000n) / BigInt(effectiveStopBps);
  const rawRiskSizedNotionalUsdc = Number(maxRawNotionalE6 / 10_000n) / 100;

  const leverageCeilingUsdc = isPm
    ? clampedRiskBudgetUsdc
    : floorToDecimals(config.maxCollateralUsdc * config.maxLeverage, 2);
  const leverageCappedNotionalUsdc = floorToDecimals(
    Math.min(rawRiskSizedNotionalUsdc, leverageCeilingUsdc),
    2
  );

  const activeLevels = isShort ? book.bids : book.asks;
  const executableDepthUsdc = computeExecutableDepthUsdc(
    activeLevels,
    limitPrice,
    direction
  );
  const depthCappedNotionalUsdc = floorToDecimals(
    Math.min(leverageCappedNotionalUsdc, executableDepthUsdc),
    2
  );

  const vwap = simulateOrderbookVwapFill(
    activeLevels,
    depthCappedNotionalUsdc > 0
      ? depthCappedNotionalUsdc
      : leverageCappedNotionalUsdc,
    limitPrice,
    direction,
    isPm
  );

  const finalSizedNotionalUsdc =
    depthCappedNotionalUsdc > 0
      ? Math.min(depthCappedNotionalUsdc, vwap.filledNotionalUsdc)
      : 0;
  const finalBaseQty =
    depthCappedNotionalUsdc > 0 ? vwap.filledBaseQty : 0;

  const finalNotionalE6 = BigInt(Math.round(finalSizedNotionalUsdc * 1_000_000));
  const exactLossScaled = finalNotionalE6 * BigInt(effectiveStopBps);
  const impliedMaxLossUsdc =
    Number((exactLossScaled + 99_999_999n) / 100_000_000n) / 100;
  const effectiveLeverage = isPm
    ? 1.0
    : Number((finalSizedNotionalUsdc / config.maxCollateralUsdc).toFixed(2));

  return {
    fixedRiskCapUsdc: clampedRiskBudgetUsdc,
    stopDistanceBps: effectiveStopBps,
    rawRiskSizedNotionalUsdc,
    leverageCappedNotionalUsdc,
    depthCappedNotionalUsdc,
    finalSizedNotionalUsdc,
    finalBaseQty,
    impliedMaxLossUsdc,
    effectiveLeverage,
    vwapFillPrice: vwap.vwapPrice,
    limitPrice,
    slippageBps: vwap.slippageBps,
  };
}

/**
 * Evaluates all 8 Fail-Closed Solana execution invariants before building or signing
 * any Devnet transaction. Supports both `LONG`/`YES` and `SHORT` directions and never
 * leaks `NaN` or `Infinity` across any numeric field.
 */
export function evaluateSolanaRiskGate(
  impulse: ImpulseSignal,
  pythFeed: PythFeedSnapshot,
  book: VenueOrderbookSnapshot,
  requestedRiskUsdc = DEFAULT_SOLANA_RISK_CONFIG.fixedRiskCapUsdc,
  config: SolanaRiskGateConfig = DEFAULT_SOLANA_RISK_CONFIG,
  nowMs = Date.now()
): SolanaRiskGateDecision {
  const isShort = impulse.direction === 'SHORT';

  const configFinite =
    Number.isFinite(config.fixedRiskCapUsdc) &&
    config.fixedRiskCapUsdc > 0 &&
    Number.isFinite(config.maxCollateralUsdc) &&
    config.maxCollateralUsdc > 0 &&
    Number.isFinite(config.maxLeverage) &&
    config.maxLeverage > 0 &&
    Number.isFinite(config.maxOracleStalenessMs) &&
    Number.isFinite(config.maxPythConfBps) &&
    Number.isFinite(config.minDislocationEdgeBps) &&
    Number.isFinite(config.maxSpreadBps) &&
    Number.isFinite(config.minExecutableDepthUsdc) &&
    Number.isFinite(config.maxSlippageBps) &&
    Number.isFinite(config.maxAdverseWhaleFlowUsdc);

  const inputsFinite =
    configFinite &&
    Number.isFinite(nowMs) &&
    Number.isFinite(requestedRiskUsdc) &&
    requestedRiskUsdc > 0 &&
    Number.isFinite(impulse.fairValuePrice) &&
    impulse.fairValuePrice > 0 &&
    Number.isFinite(impulse.stopDistanceBps) &&
    impulse.stopDistanceBps >= 25 &&
    impulse.stopDistanceBps <= 10_000 &&
    Number.isFinite(impulse.adverseWhaleFlowUsdc) &&
    Number.isFinite(book.bestAsk) &&
    book.bestAsk > 0 &&
    Number.isFinite(book.bestBid) &&
    (isShort ? book.bestBid > 0 : book.bestBid >= 0) &&
    Number.isFinite(book.spread) &&
    book.spread >= 0 &&
    Number.isFinite(book.adverseWhaleFlowUsdc);

  const isPm = isPredictionVenue(book);
  const sizing = inputsFinite
    ? sizePositionByFixedLoss(
        requestedRiskUsdc,
        impulse.stopDistanceBps,
        book,
        config,
        impulse.direction
      )
    : sizePositionByFixedLoss(-1, 0, book, config, impulse.direction);

  const oracleGuard = evaluatePythOracleGuard(
    pythFeed,
    configFinite ? config.maxOracleStalenessMs : 45_000,
    configFinite ? config.maxPythConfBps : 30
  );

  const activeBookSide = isShort ? book.bids : book.asks;
  const availableDepthUsdc =
    inputsFinite && sizing.limitPrice > 0
      ? computeExecutableDepthUsdc(
          activeBookSide,
          sizing.limitPrice,
          impulse.direction
        )
      : 0;

  const spreadBps = inputsFinite
    ? isPm
      ? Number((book.spread * 10_000).toFixed(2))
      : Number(
          (((book.bestAsk - book.bestBid) / book.bestAsk) * 10_000).toFixed(2)
        )
    : 99_999;

  const edgeBps = inputsFinite
    ? isPm
      ? Number(
          (
            (isShort
              ? book.bestBid - impulse.fairValuePrice
              : impulse.fairValuePrice - book.bestAsk) * 10_000
          ).toFixed(2)
        )
      : Number(
          (
            ((isShort
              ? book.bestBid - impulse.fairValuePrice
              : impulse.fairValuePrice - book.bestAsk) /
              (isShort ? book.bestBid : book.bestAsk)) *
            10_000
          ).toFixed(2)
        )
    : 0;

  const maxAllowedSpreadBps = isPm
    ? Math.max(config.maxSpreadBps, 400)
    : config.maxSpreadBps;
  const minRequiredEdgeBps = isPm
    ? Math.max(config.minDislocationEdgeBps, 450)
    : config.minDislocationEdgeBps;
  const maxAllowedSlippageBps = isPm
    ? Math.max(config.maxSlippageBps, 150)
    : config.maxSlippageBps;

  const onChainLossCapOk =
    inputsFinite &&
    sizing.stopDistanceBps >= 25 &&
    BigInt(Math.round(sizing.finalSizedNotionalUsdc * 1_000_000)) *
      BigInt(Math.round(sizing.stopDistanceBps)) <=
      BigInt(Math.round(config.fixedRiskCapUsdc * 1_000_000)) * 10_000n;

  const riskCapLocked =
    inputsFinite &&
    sizing.fixedRiskCapUsdc > 0 &&
    sizing.fixedRiskCapUsdc <= config.fixedRiskCapUsdc &&
    sizing.impliedMaxLossUsdc <= sizing.fixedRiskCapUsdc &&
    sizing.impliedMaxLossUsdc <= config.fixedRiskCapUsdc &&
    onChainLossCapOk;

  const bookAgeMs = inputsFinite
    ? Math.max(0, nowMs - book.fetchedAtMs)
    : Number.MAX_SAFE_INTEGER;
  const oracleFreshOk =
    oracleGuard.rejectionCode !== 'ORACLE_STALE_FRAME' &&
    oracleGuard.rejectionCode !== 'ORACLE_NON_POSITIVE' &&
    bookAgeMs <= (configFinite ? config.maxOracleStalenessMs : 45_000);
  const oracleConfOk =
    oracleGuard.passed &&
    oracleGuard.rejectionCode !== 'ORACLE_CONFIDENCE_TOO_WIDE';

  const cuiBonoOk = Boolean(impulse.cuiBonoSafe);
  const adverseFlow = inputsFinite
    ? Math.max(book.adverseWhaleFlowUsdc, impulse.adverseWhaleFlowUsdc)
    : Number.MAX_SAFE_INTEGER;
  const whaleFlowOk =
    inputsFinite && adverseFlow < config.maxAdverseWhaleFlowUsdc;
  const whaleSafeOk = cuiBonoOk && whaleFlowOk;

  const spreadOk =
    inputsFinite &&
    book.asks.length > 0 &&
    book.bids.length > 0 &&
    spreadBps <= maxAllowedSpreadBps;
  const depthOk =
    inputsFinite && availableDepthUsdc >= config.minExecutableDepthUsdc;
  const onChainPythSlipOk = (() => {
    if (!inputsFinite || isPm || pythFeed.priceUsd <= 0 || sizing.limitPrice <= 0) {
      return true;
    }
    const oracleE6 = BigInt(Math.round(pythFeed.priceUsd * 1_000_000));
    const refE6 = BigInt(
      Math.round((isShort ? book.bestBid : book.bestAsk) * 1_000_000)
    );
    const limE6 = BigInt(Math.round(sizing.limitPrice * 1_000_000));
    const absDev = refE6 >= oracleE6 ? refE6 - oracleE6 : oracleE6 - refE6;
    if (absDev * 10_000n > oracleE6 * 150n) return false;
    const totalOracleBps =
      150n + BigInt(Math.floor(Number(maxAllowedSlippageBps.toPrecision(12))));
    return isShort
      ? limE6 >= (oracleE6 * (10_000n - totalOracleBps)) / 10_000n
      : limE6 <= (oracleE6 * (10_000n + totalOracleBps)) / 10_000n;
  })();

  const slippageOk =
    inputsFinite &&
    sizing.finalSizedNotionalUsdc > 0 &&
    sizing.slippageBps <= maxAllowedSlippageBps &&
    onChainPythSlipOk;
  const edgeOk = inputsFinite && edgeBps >= minRequiredEdgeBps;

  const expectedValueUsdc =
    riskCapLocked && sizing.finalBaseQty > 0 && sizing.vwapFillPrice > 0
      ? Number(
          (
            sizing.finalBaseQty *
            (isShort
              ? sizing.vwapFillPrice - impulse.fairValuePrice
              : impulse.fairValuePrice - sizing.vwapFillPrice)
          ).toFixed(2)
        )
      : 0;

  const checks = {
    riskCapLocked,
    oracleFreshOk,
    oracleConfOk,
    whaleSafeOk,
    spreadOk,
    depthOk,
    slippageOk,
    edgeOk,
  };

  if (!riskCapLocked) {
    return {
      passed: false,
      rejectionCode: 'RISK_CAP_VIOLATION',
      reason:
        'Fail-Closed Block: Non-finite or invalid risk-cap / stop-distance parameter',
      edgeBps,
      spreadBps,
      pythConfBps: oracleGuard.confBps,
      oracleAgeMs: oracleGuard.ageMs,
      availableDepthUsdc,
      expectedValueUsdc: 0,
      sizing,
      checks,
    };
  }

  if (oracleGuard.rejectionCode === 'ORACLE_NON_POSITIVE') {
    return {
      passed: false,
      rejectionCode: 'ORACLE_NON_POSITIVE',
      reason: oracleGuard.reason,
      edgeBps,
      spreadBps,
      pythConfBps: oracleGuard.confBps,
      oracleAgeMs: oracleGuard.ageMs,
      availableDepthUsdc,
      expectedValueUsdc: 0,
      sizing,
      checks,
    };
  }

  if (!oracleFreshOk) {
    return {
      passed: false,
      rejectionCode: 'ORACLE_STALE_FRAME',
      reason:
        oracleGuard.rejectionCode === 'ORACLE_STALE_FRAME'
          ? oracleGuard.reason
          : `Fail-Closed Block: Orderbook telemetry stale (${(bookAgeMs / 1000).toFixed(1)}s)`,
      edgeBps,
      spreadBps,
      pythConfBps: oracleGuard.confBps,
      oracleAgeMs: Math.max(oracleGuard.ageMs, bookAgeMs),
      availableDepthUsdc,
      expectedValueUsdc: 0,
      sizing,
      checks,
    };
  }

  if (!oracleConfOk) {
    return {
      passed: false,
      rejectionCode: 'ORACLE_CONFIDENCE_TOO_WIDE',
      reason: oracleGuard.reason,
      edgeBps,
      spreadBps,
      pythConfBps: oracleGuard.confBps,
      oracleAgeMs: oracleGuard.ageMs,
      availableDepthUsdc,
      expectedValueUsdc: 0,
      sizing,
      checks,
    };
  }

  if (!cuiBonoOk) {
    return {
      passed: false,
      rejectionCode: 'CUI_BONO_INVALIDATED',
      reason:
        'Fail-Closed Block: Cui Bono / structural incentive sentinel invalidated impulse',
      edgeBps,
      spreadBps,
      pythConfBps: oracleGuard.confBps,
      oracleAgeMs: oracleGuard.ageMs,
      availableDepthUsdc,
      expectedValueUsdc: 0,
      sizing,
      checks,
    };
  }

  if (!whaleFlowOk) {
    return {
      passed: false,
      rejectionCode: 'WHALE_TOXICITY_ALERT',
      reason: `Fail-Closed Block: Adverse smart-money sweep ($${adverseFlow.toFixed(0)} >= $${config.maxAdverseWhaleFlowUsdc.toFixed(0)})`,
      edgeBps,
      spreadBps,
      pythConfBps: oracleGuard.confBps,
      oracleAgeMs: oracleGuard.ageMs,
      availableDepthUsdc,
      expectedValueUsdc: 0,
      sizing,
      checks,
    };
  }

  if (!spreadOk) {
    return {
      passed: false,
      rejectionCode: 'SPREAD_TOO_WIDE',
      reason: `Fail-Closed Block: Venue spread ${spreadBps.toFixed(1)} bps > ${maxAllowedSpreadBps.toFixed(1)} bps ceiling`,
      edgeBps,
      spreadBps,
      pythConfBps: oracleGuard.confBps,
      oracleAgeMs: oracleGuard.ageMs,
      availableDepthUsdc,
      expectedValueUsdc: 0,
      sizing,
      checks,
    };
  }

  if (!depthOk) {
    const sideLabel = isShort ? 'bid' : 'ask';
    return {
      passed: false,
      rejectionCode: 'INSUFFICIENT_DEPTH',
      reason: `Fail-Closed Block: Executable ${sideLabel} depth $${availableDepthUsdc.toFixed(2)} < $${config.minExecutableDepthUsdc.toFixed(2)} floor`,
      edgeBps,
      spreadBps,
      pythConfBps: oracleGuard.confBps,
      oracleAgeMs: oracleGuard.ageMs,
      availableDepthUsdc,
      expectedValueUsdc: 0,
      sizing,
      checks,
    };
  }

  if (!slippageOk) {
    return {
      passed: false,
      rejectionCode: 'SLIPPAGE_EXCEEDED',
      reason: `Fail-Closed Block: Simulated VWAP slippage ${sizing.slippageBps.toFixed(1)} bps > ${maxAllowedSlippageBps.toFixed(1)} bps cap`,
      edgeBps,
      spreadBps,
      pythConfBps: oracleGuard.confBps,
      oracleAgeMs: oracleGuard.ageMs,
      availableDepthUsdc,
      expectedValueUsdc: 0,
      sizing,
      checks,
    };
  }

  if (!edgeOk) {
    return {
      passed: false,
      rejectionCode: 'EDGE_BELOW_THRESHOLD',
      reason: `Fail-Closed Block: Dislocation edge ${edgeBps.toFixed(1)} bps < ${minRequiredEdgeBps.toFixed(1)} bps threshold`,
      edgeBps,
      spreadBps,
      pythConfBps: oracleGuard.confBps,
      oracleAgeMs: oracleGuard.ageMs,
      availableDepthUsdc,
      expectedValueUsdc: 0,
      sizing,
      checks,
    };
  }

  return {
    passed: true,
    rejectionCode: 'NONE',
    reason: `ALL 8 GATES GREEN: +${edgeBps.toFixed(1)} bps Edge · Pyth ±${oracleGuard.confBps.toFixed(1)} bps · $${sizing.finalSizedNotionalUsdc.toFixed(2)} Sized (Max Loss $${sizing.impliedMaxLossUsdc.toFixed(2)})`,
    edgeBps,
    spreadBps,
    pythConfBps: oracleGuard.confBps,
    oracleAgeMs: oracleGuard.ageMs,
    availableDepthUsdc,
    expectedValueUsdc,
    sizing,
    checks,
  };
}
