import type {
  ImpulseSignal,
  PositionSizingBreakdown,
  PythFeedSnapshot,
  SolanaRiskGateConfig,
  SolanaRiskGateDecision,
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
  minDislocationEdgeBps: 35.0, // +35 bps min edge for Perps (+450 bps / +4.5c for binary PM)
  maxSpreadBps: 35.0, // <= 35 bps spread for Perps (<= 400 bps / 4.0c for binary PM)
  minExecutableDepthUsdc: 25.0, // >= $25 USDC executable top-of-book depth
  maxSlippageBps: 20.0, // <= 20 bps VWAP slippage for Perps (<= 150 bps / 1.5c for PM)
  maxAdverseWhaleFlowUsdc: 1000.0, // Pre-headline counter-whale toxicity limit
};

function isPredictionVenue(book: VenueOrderbookSnapshot): boolean {
  return (
    book.venue === 'SOLANA_DRIFT_BET_PM' ||
    book.venue === 'POLYMARKET_GAMMA_PM'
  );
}

/**
 * Pure Fixed-Loss Position Sizer ("以损定仓"):
 * - For Solana Perpetuals: `rawNotional = fixedRiskCapUsdc / (stopDistanceBps / 10_000)`,
 *   clamped by `maxCollateralUsdc * maxLeverage` and executable book depth within `limitPrice`.
 * - For Binary Prediction Markets: `stopDistanceBps = 10_000` (100% binary resolution risk),
 *   so `finalSizedNotionalUsdc <= fixedRiskCapUsdc` ($10.00 USDC hard cap).
 */
export function sizePositionByFixedLoss(
  requestedRiskUsdc: number,
  stopDistanceBps: number,
  book: VenueOrderbookSnapshot,
  config: SolanaRiskGateConfig = DEFAULT_SOLANA_RISK_CONFIG
): PositionSizingBreakdown {
  const validInputs =
    Number.isFinite(requestedRiskUsdc) &&
    requestedRiskUsdc > 0 &&
    Number.isFinite(stopDistanceBps) &&
    stopDistanceBps >= 25 &&
    stopDistanceBps <= 10_000 &&
    Number.isFinite(book.bestAsk) &&
    book.bestAsk > 0 &&
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
  const clampedRiskBudgetUsdc = Number(
    Math.min(requestedRiskUsdc, config.fixedRiskCapUsdc).toFixed(2)
  );
  const effectiveStopBps = isPm ? 10_000 : stopDistanceBps;
  const maxSlipBps = isPm ? Math.max(config.maxSlippageBps, 150) : config.maxSlippageBps;

  const limitPrice = isPm
    ? Number(Math.min(0.99, book.bestAsk + 0.015).toFixed(4))
    : Number((book.bestAsk * (1 + maxSlipBps / 10_000)).toFixed(4));

  const rawRiskSizedNotionalUsdc = Number(
    ((clampedRiskBudgetUsdc * 10_000) / effectiveStopBps).toFixed(2)
  );
  const leverageCeilingUsdc = isPm
    ? clampedRiskBudgetUsdc
    : Number((config.maxCollateralUsdc * config.maxLeverage).toFixed(2));
  const leverageCappedNotionalUsdc = Number(
    Math.min(rawRiskSizedNotionalUsdc, leverageCeilingUsdc).toFixed(2)
  );

  const executableDepthUsdc = computeExecutableDepthUsdc(book.asks, limitPrice);
  const depthCappedNotionalUsdc = Number(
    Math.min(leverageCappedNotionalUsdc, executableDepthUsdc).toFixed(2)
  );

  const vwap = simulateOrderbookVwapFill(
    book.asks,
    depthCappedNotionalUsdc > 0 ? depthCappedNotionalUsdc : leverageCappedNotionalUsdc,
    limitPrice
  );

  const finalSizedNotionalUsdc =
    depthCappedNotionalUsdc > 0 ? vwap.filledNotionalUsdc : 0;
  const finalBaseQty =
    depthCappedNotionalUsdc > 0 ? vwap.filledBaseQty : 0;
  const impliedMaxLossUsdc = Number(
    ((finalSizedNotionalUsdc * effectiveStopBps) / 10_000).toFixed(2)
  );
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
 * any Devnet transaction. Never leaks `NaN` or `Infinity` across any numeric field.
 */
export function evaluateSolanaRiskGate(
  impulse: ImpulseSignal,
  pythFeed: PythFeedSnapshot,
  book: VenueOrderbookSnapshot,
  requestedRiskUsdc = DEFAULT_SOLANA_RISK_CONFIG.fixedRiskCapUsdc,
  config: SolanaRiskGateConfig = DEFAULT_SOLANA_RISK_CONFIG,
  nowMs = Date.now()
): SolanaRiskGateDecision {
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
    book.bestBid >= 0 &&
    Number.isFinite(book.spread) &&
    book.spread >= 0 &&
    Number.isFinite(book.adverseWhaleFlowUsdc);

  const isPm = isPredictionVenue(book);
  const sizing = inputsFinite
    ? sizePositionByFixedLoss(
        requestedRiskUsdc,
        impulse.stopDistanceBps,
        book,
        config
      )
    : sizePositionByFixedLoss(-1, 0, book, config);

  const oracleGuard = evaluatePythOracleGuard(
    pythFeed,
    configFinite ? config.maxOracleStalenessMs : 45_000,
    configFinite ? config.maxPythConfBps : 30
  );

  const availableDepthUsdc =
    inputsFinite && sizing.limitPrice > 0
      ? computeExecutableDepthUsdc(book.asks, sizing.limitPrice)
      : 0;

  const spreadBps = inputsFinite
    ? isPm
      ? Number((book.spread * 10_000).toFixed(2))
      : Number((((book.bestAsk - book.bestBid) / book.bestAsk) * 10_000).toFixed(2))
    : 99_999;

  const edgeBps = inputsFinite
    ? isPm
      ? Number(((impulse.fairValuePrice - book.bestAsk) * 10_000).toFixed(2))
      : Number(
          (((impulse.fairValuePrice - book.bestAsk) / book.bestAsk) * 10_000).toFixed(
            2
          )
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

  const riskCapLocked =
    inputsFinite &&
    sizing.fixedRiskCapUsdc > 0 &&
    sizing.fixedRiskCapUsdc <= config.fixedRiskCapUsdc &&
    sizing.impliedMaxLossUsdc <= config.fixedRiskCapUsdc + 0.01;

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
  const slippageOk =
    inputsFinite &&
    sizing.finalSizedNotionalUsdc > 0 &&
    sizing.slippageBps <= maxAllowedSlippageBps;
  const edgeOk = inputsFinite && edgeBps >= minRequiredEdgeBps;

  const expectedValueUsdc =
    riskCapLocked && sizing.finalBaseQty > 0 && sizing.vwapFillPrice > 0
      ? Number(
          (
            sizing.finalBaseQty * (impulse.fairValuePrice - sizing.vwapFillPrice)
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
    return {
      passed: false,
      rejectionCode: 'INSUFFICIENT_DEPTH',
      reason: `Fail-Closed Block: Executable ask depth $${availableDepthUsdc.toFixed(2)} < $${config.minExecutableDepthUsdc.toFixed(2)} floor`,
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
