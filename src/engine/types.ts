export type SupportedAsset = 'SOL' | 'BTC' | 'ETH';

export type PythSourceMode =
  | 'HERMES_V2_STREAM'
  | 'SOLANA_ONCHAIN_RECEIVER'
  | 'CURATED_REPLAY';

export interface PythFeedSnapshot {
  asset: SupportedAsset;
  symbol: string;
  feedIdHex: string;
  priceUpdateAccount: string;
  priceUsd: number;
  confUsd: number;
  confBps: number;
  emaPriceUsd: number;
  exponent: number;
  publishTimeSec: number;
  ageMs: number;
  postedSlot: number;
  spotReferenceUsd: number;
  spotDislocationBps: number;
  source: PythSourceMode;
  cluster?: 'devnet' | 'mainnet-beta';
  verificationLevel?: 'FULL' | 'PARTIAL';
}

export type OracleRejectionCode =
  | 'NONE'
  | 'ORACLE_NON_POSITIVE'
  | 'ORACLE_STALE_FRAME'
  | 'ORACLE_CONFIDENCE_TOO_WIDE';

export interface OracleGuardVerdict {
  passed: boolean;
  rejectionCode: OracleRejectionCode;
  reason: string;
  confBps: number;
  ageMs: number;
  spotDislocationBps: number;
  maxConfBps: number;
  maxStalenessMs: number;
}

export type VenueKind =
  | 'SOLANA_DRIFT_PERP'
  | 'SOLANA_DRIFT_BET_PM'
  | 'POLYMARKET_GAMMA_PM';

export type OrderExecutionStyle = 'IOC_LIMIT' | 'POST_ONLY';

export type TradeDirection = 'LONG' | 'SHORT' | 'YES';

export interface OrderbookLevel {
  price: number;
  sizeBase: number;
  notionalUsdc: number;
}

export interface VenueOrderbookSnapshot {
  marketId: string;
  symbol: string;
  title: string;
  venue: VenueKind;
  asset: SupportedAsset;
  marketIndex: number;
  marketPda: string;
  oraclePubkey: string;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spread: number;
  spreadBps: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  executableAskDepthUsdc: number;
  adverseWhaleFlowUsdc: number;
  fetchedAtMs: number;
  slot: number;
  sourceLabel: string;
}

export type ScenarioId =
  | 'sol-perp-breakout'
  | 'btc-cpi-conf-blowout'
  | 'eth-stale-oracle-trap'
  | 'pm-thin-depth-trap'
  | 'sol-adverse-whale-trap'
  | 'pm-clutch-repricing';

export interface ImpulseSignal {
  id: string;
  scenarioId: ScenarioId;
  title: string;
  category:
    | 'PERP_BREAKOUT'
    | 'MACRO_SHOCK'
    | 'SPORTS_PM'
    | 'ORACLE_TRAP'
    | 'LIQUIDITY_TRAP';
  venue: VenueKind;
  asset: SupportedAsset;
  marketSymbol: string;
  direction: TradeDirection;
  spotMoveBps: number;
  fairValuePrice: number;
  stopDistanceBps: number;
  cuiBonoSafe: boolean;
  adverseWhaleFlowUsdc: number;
  detectedAtMs: number;
  narrative: string;
}

export interface SolanaRiskGateConfig {
  fixedRiskCapUsdc: number; // Default: 10.00 USDC hard max loss per impulse
  maxCollateralUsdc: number; // Default: 160.00 USDC margin allocation cap
  maxLeverage: number; // Default: 5.0x ceiling for Perps
  maxOracleStalenessMs: number; // Default: 45_000 ms (45s)
  maxPythConfBps: number; // Default: 30 bps (0.30%)
  minDislocationEdgeBps: number; // Default: 35 bps (0.35%) for Perps / 450 bps (4.5c) for PM
  maxSpreadBps: number; // Default: 35 bps for Perps / 400 bps (4.0c) for PM
  minExecutableDepthUsdc: number; // Default: 25.00 USDC
  maxSlippageBps: number; // Default: 20 bps for Perps / 150 probability bps (1.5c) for PM
  maxAdverseWhaleFlowUsdc: number; // Default: 1000.00 USDC
}

export interface PositionSizingBreakdown {
  fixedRiskCapUsdc: number;
  stopDistanceBps: number;
  rawRiskSizedNotionalUsdc: number;
  leverageCappedNotionalUsdc: number;
  depthCappedNotionalUsdc: number;
  finalSizedNotionalUsdc: number;
  finalBaseQty: number;
  impliedMaxLossUsdc: number;
  effectiveLeverage: number;
  vwapFillPrice: number;
  limitPrice: number;
  slippageBps: number;
}

export type SolanaRiskRejectionCode =
  | 'NONE'
  | 'RISK_CAP_VIOLATION'
  | 'ORACLE_NON_POSITIVE'
  | 'ORACLE_STALE_FRAME'
  | 'ORACLE_CONFIDENCE_TOO_WIDE'
  | 'CUI_BONO_INVALIDATED'
  | 'WHALE_TOXICITY_ALERT'
  | 'SPREAD_TOO_WIDE'
  | 'INSUFFICIENT_DEPTH'
  | 'SLIPPAGE_EXCEEDED'
  | 'EDGE_BELOW_THRESHOLD';

export interface SolanaRiskGateChecks {
  riskCapLocked: boolean;
  oracleFreshOk: boolean;
  oracleConfOk: boolean;
  whaleSafeOk: boolean;
  spreadOk: boolean;
  depthOk: boolean;
  slippageOk: boolean;
  edgeOk: boolean;
}

export interface SolanaRiskGateDecision {
  passed: boolean;
  rejectionCode: SolanaRiskRejectionCode;
  reason: string;
  edgeBps: number;
  spreadBps: number;
  pythConfBps: number;
  oracleAgeMs: number;
  availableDepthUsdc: number;
  expectedValueUsdc: number;
  sizing: PositionSizingBreakdown;
  checks: SolanaRiskGateChecks;
}

export type SolanaSignerMode =
  | 'DEVNET_WALLET_STANDARD'
  | 'DEVNET_KEYPAIR_LIVE'
  | 'DEVNET_BPF_SIMULATION'
  | 'OFFLINE_ED25519_SIGNED';

export type SolanaBroadcastStatus =
  | 'CONFIRMED_ON_DEVNET'
  | 'SIMULATED_DEVNET_BPF'
  | 'OFFLINE_ED25519_SIGNED';

export interface LatencyWaterfallMs {
  detectToOracleMs: number;
  riskGateMs: number;
  txBuildSignMs: number;
  solanaRpcConfirmMs: number;
  totalEndToEndMs: number;
}

export interface SignedAtomicV0Bundle {
  txSignature: string;
  messageBase64: string;
  executedPrograms: string[];
  instructionCount: number;
  ed25519Verified: boolean;
  explorerInspectorUrl: string;
}

export interface SolanaExecutionReceipt {
  receiptId: string;
  scenarioId: ScenarioId;
  marketSymbol: string;
  venue: VenueKind;
  orderStyle: OrderExecutionStyle;
  direction: TradeDirection;
  signerMode: SolanaSignerMode;
  traderPubkey: string;
  fixedRiskCapUsdc: number;
  stopDistanceBps: number;
  sizedNotionalUsdc: number;
  sizedBaseQty: number;
  impliedMaxLossUsdc: number;
  limitPrice: number;
  vwapFillPrice: number;
  expectedValueUsdc: number;
  pythPriceUsd: number;
  pythConfBps: number;
  pythAccount: string;
  targetMarketPda: string;
  driftOraclePubkey: string;
  riskGuardProgramId: string;
  driftProgramId: string;
  executedPrograms: string[];
  instructionCount: number;
  decisionDigestHex: string;
  txSignature: string;
  messageBase64: string;
  atomicFourProgramBundle?: SignedAtomicV0Bundle;
  broadcastStatus: SolanaBroadcastStatus;
  rpcSimulationNote?: string;
  devnetSlot: number;
  computeUnitsConsumed: number;
  priorityFeeMicroLamports: number;
  bpfLogs: string[];
  ed25519Verified: boolean;
  latencyMs: LatencyWaterfallMs;
  explorerTxUrl: string;
  explorerInspectorUrl: string;
  explorerOracleAccountUrl: string;
  explorerMarketPdaUrl: string;
  createdAtIso: string;
}

export type HudWaveguideMode = 'IDLE_BAR' | 'IMPULSE_ALERT' | 'TX_RECEIPT';

export interface HudCompanionSnapshot {
  mode: HudWaveguideMode;
  orderStyle: OrderExecutionStyle;
  topBarText: string;
  alertBodyText: string;
  footerHintText: string;
  updatedAtMs: number;
}
