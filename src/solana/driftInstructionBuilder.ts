import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type {
  ImpulseSignal,
  OrderExecutionStyle,
  PythFeedSnapshot,
  SolanaRiskGateDecision,
  TradeDirection,
  VenueOrderbookSnapshot,
} from '../engine/types';
import { DRIFT_V2_PROGRAM_ID } from '../venues/marketDataClient';

export const LIVEEDGE_RISK_GUARD_PROGRAM_ID =
  '7X5WrZSYtxx89cpEs9A79SSQ2ZHJtkX32fBXcwpyd7uD';

export const SPL_MEMO_V2_PROGRAM_ID =
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export const COMPUTE_BUDGET_PROGRAM_ID =
  'ComputeBudget111111111111111111111111111111';

export function toInstructionData(bytes: Uint8Array): Buffer {
  const normalized = new Uint8Array(bytes.length);
  normalized.set(bytes);
  return normalized as unknown as Buffer;
}

export function buildSetComputeUnitLimitInstruction(
  units: number
): TransactionInstruction {
  const raw = new Uint8Array(5);
  const view = new DataView(raw.buffer);
  view.setUint8(0, 2); // SetComputeUnitLimit instruction tag = 2
  view.setUint32(1, Math.max(1_000, Math.round(units)), true);
  return new TransactionInstruction({
    programId: new PublicKey(COMPUTE_BUDGET_PROGRAM_ID),
    keys: [],
    data: toInstructionData(raw),
  });
}

export function buildSetComputeUnitPriceInstruction(
  microLamports: number
): TransactionInstruction {
  const raw = new Uint8Array(9);
  const view = new DataView(raw.buffer);
  view.setUint8(0, 3); // SetComputeUnitPrice instruction tag = 3
  view.setBigUint64(1, BigInt(Math.max(0, Math.round(microLamports))), true);
  return new TransactionInstruction({
    programId: new PublicKey(COMPUTE_BUDGET_PROGRAM_ID),
    keys: [],
    data: toInstructionData(raw),
  });
}

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  let num = BigInt('0x' + hex);
  let out = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    out = BASE58_ALPHABET[rem] + out;
    num /= 58n;
  }
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      out = '1' + out;
    } else {
      break;
    }
  }
  return out;
}

export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
  );
  return new Uint8Array(buf);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const digest = await sha256Bytes(input);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    hex += digest[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function deriveRiskPolicyPda(authority: PublicKey): [PublicKey, number] {
  const programId = new PublicKey(LIVEEDGE_RISK_GUARD_PROGRAM_ID);
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('risk_policy'), authority.toBytes()],
    programId
  );
}

export function deriveDriftUserPdas(
  authority: PublicKey,
  subAccountId = 0
): {
  statePda: PublicKey;
  userPda: PublicKey;
  userStatsPda: PublicKey;
} {
  const driftPid = new PublicKey(DRIFT_V2_PROGRAM_ID);
  const subBuf = new Uint8Array(2);
  new DataView(subBuf.buffer).setUint16(0, subAccountId, true);

  const [statePda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('drift_state')],
    driftPid
  );
  const [userPda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('user'), authority.toBytes(), subBuf],
    driftPid
  );
  const [userStatsPda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('user_stats'), authority.toBytes()],
    driftPid
  );

  return { statePda, userPda, userStatsPda };
}

/**
 * Encodes Anchor `LiveEdgeRiskGuard::executeGuardedImpulse` instruction matching
 * `programs/liveedge_risk_guard/src/lib.rs` (`GuardedImpulseParams` Borsh layout).
 */
export async function buildAnchorRiskGuardInstruction(params: {
  authority: PublicKey;
  pythPriceUpdate: PublicKey;
  targetMarket: PublicKey;
  expectedPythFeedIdHex: string;
  sizedNotionalUsdc: number;
  stopDistanceBps: number;
  referenceAsk: number;
  limitPrice: number;
  orderStyle: OrderExecutionStyle;
  decisionDigestBytes: Uint8Array;
}): Promise<TransactionInstruction> {
  const discFull = await sha256Bytes('global:execute_guarded_impulse');
  const discriminator = discFull.subarray(0, 8);
  const feedBytes = hexToBytes(params.expectedPythFeedIdHex);
  if (feedBytes.length !== 32) {
    throw new Error('expectedPythFeedIdHex must be 32 bytes (64 hex chars)');
  }
  if (params.decisionDigestBytes.length !== 32) {
    throw new Error('decisionDigestBytes must be 32 bytes');
  }

  // Borsh layout:
  // [0..8]   discriminator
  // [8..40]  expected_pyth_feed_id ([u8; 32])
  // [40..48] sized_notional_usdc_e6 (u64 LE)
  // [48..50] stop_distance_bps (u16 LE)
  // [50..58] reference_ask_e6 (u64 LE)
  // [58..66] limit_price_e6 (u64 LE)
  // [66]     order_mode enum (0 = BlindMarket [forbidden], 1 = IocLimit, 2 = PostOnly)
  // [67..99] decision_digest ([u8; 32])
  const payload = new Uint8Array(99);
  payload.set(discriminator, 0);
  payload.set(feedBytes, 8);

  const view = new DataView(payload.buffer);
  view.setBigUint64(
    40,
    BigInt(Math.round(params.sizedNotionalUsdc * 1_000_000)),
    true
  );
  view.setUint16(48, Math.round(params.stopDistanceBps), true);
  view.setBigUint64(50, BigInt(Math.round(params.referenceAsk * 1_000_000)), true);
  view.setBigUint64(58, BigInt(Math.round(params.limitPrice * 1_000_000)), true);
  view.setUint8(66, params.orderStyle === 'POST_ONLY' ? 2 : 1);
  payload.set(params.decisionDigestBytes, 67);

  const [riskPolicyPda] = deriveRiskPolicyPda(params.authority);

  return new TransactionInstruction({
    programId: new PublicKey(LIVEEDGE_RISK_GUARD_PROGRAM_ID),
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: riskPolicyPda, isSigner: false, isWritable: true },
      { pubkey: params.pythPriceUpdate, isSigner: false, isWritable: false },
      { pubkey: params.targetMarket, isSigner: false, isWritable: false },
    ],
    data: toInstructionData(payload),
  });
}

/**
 * Encodes a bounded Drift Protocol v2 `placePerpOrder` instruction (`dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`).
 * Never uses `OrderType::Market` (0); strictly uses `OrderType::Limit` (1) with
 * `immediateOrCancel = true` (`IOC_LIMIT`) or `PostOnlyParam::MustPostOnly` (`POST_ONLY`).
 */
export async function buildDriftPlacePerpOrderInstruction(params: {
  authority: PublicKey;
  marketIndex: number;
  marketPda: PublicKey;
  oraclePubkey: PublicKey;
  direction: TradeDirection;
  baseQty: number;
  limitPrice: number;
  orderStyle: OrderExecutionStyle;
}): Promise<TransactionInstruction> {
  const discFull = await sha256Bytes('global:place_perp_order');
  const discriminator = discFull.subarray(0, 8);

  // Drift `OrderParams` Borsh serialization:
  // order_type: u8 (1 = Limit)
  // market_type: u8 (1 = Perp)
  // direction: u8 (0 = Long, 1 = Short)
  // user_order_id: u8 (1)
  // base_asset_amount: u64 (BASE_PRECISION = 10^9)
  // price: u64 (PRICE_PRECISION = 10^6)
  // market_index: u16
  // reduce_only: bool (0)
  // post_only: u8 (0 = None, 1 = MustPostOnly)
  // immediate_or_cancel: bool (1 for IOC_LIMIT, 0 for POST_ONLY)
  // max_ts: Option<i64> (0 = None)
  // trigger_price: Option<u64> (0 = None)
  // trigger_condition: u8 (0 = Above)
  // oracle_price_offset: Option<i32> (0 = None)
  // auction_duration: Option<u8> (0 = None)
  // auction_start_price: Option<i64> (0 = None)
  // auction_end_price: Option<i64> (0 = None)
  const buf = new Uint8Array(8 + 32);
  buf.set(discriminator, 0);
  const view = new DataView(buf.buffer);
  let off = 8;
  view.setUint8(off++, 1); // OrderType::Limit
  view.setUint8(off++, 1); // MarketType::Perp
  view.setUint8(off++, params.direction === 'SHORT' ? 1 : 0);
  view.setUint8(off++, 1); // user_order_id
  view.setBigUint64(off, BigInt(Math.round(params.baseQty * 1_000_000_000)), true);
  off += 8;
  view.setBigUint64(off, BigInt(Math.round(params.limitPrice * 1_000_000)), true);
  off += 8;
  view.setUint16(off, params.marketIndex, true);
  off += 2;
  view.setUint8(off++, 0); // reduce_only = false
  view.setUint8(off++, params.orderStyle === 'POST_ONLY' ? 1 : 0);
  view.setUint8(off++, params.orderStyle === 'IOC_LIMIT' ? 1 : 0);
  view.setUint8(off++, 0); // max_ts = None
  view.setUint8(off++, 0); // trigger_price = None
  view.setUint8(off++, 0); // trigger_condition = Above
  view.setUint8(off++, 0); // oracle_price_offset = None
  view.setUint8(off++, 0); // auction_duration = None
  view.setUint8(off++, 0); // auction_start_price = None
  view.setUint8(off++, 0); // auction_end_price = None

  const { statePda, userPda } = deriveDriftUserPdas(params.authority, 0);

  return new TransactionInstruction({
    programId: new PublicKey(DRIFT_V2_PROGRAM_ID),
    keys: [
      { pubkey: statePda, isSigner: false, isWritable: false },
      { pubkey: userPda, isSigner: false, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.oraclePubkey, isSigner: false, isWritable: false },
      { pubkey: params.marketPda, isSigner: false, isWritable: true },
    ],
    data: toInstructionData(buf.subarray(0, off)),
  });
}

export interface CanonicalAuditEnvelope {
  v: 'liveedge-solana/v1';
  market: string;
  venue: string;
  dir: TradeDirection;
  style: OrderExecutionStyle;
  riskCapUsdc: number;
  stopBps: number;
  notionalUsdc: number;
  qty: number;
  limitPrice: number;
  pythPrice: number;
  pythConfBps: number;
  pythAcc: string;
  marketPda: string;
  digest: string;
}

export async function buildCanonicalAuditMemoInstruction(params: {
  trader: PublicKey;
  impulse: ImpulseSignal;
  pythFeed: PythFeedSnapshot;
  book: VenueOrderbookSnapshot;
  decision: SolanaRiskGateDecision;
  orderStyle: OrderExecutionStyle;
}): Promise<{
  instruction: TransactionInstruction;
  envelope: CanonicalAuditEnvelope;
  decisionDigestHex: string;
  decisionDigestBytes: Uint8Array;
}> {
  const preimage = JSON.stringify({
    scenarioId: params.impulse.scenarioId,
    market: params.book.symbol,
    venue: params.book.venue,
    direction: params.impulse.direction,
    orderStyle: params.orderStyle,
    trader: params.trader.toBase58(),
    fixedRiskCapUsdc: params.decision.sizing.fixedRiskCapUsdc,
    stopDistanceBps: params.decision.sizing.stopDistanceBps,
    sizedNotionalUsdc: params.decision.sizing.finalSizedNotionalUsdc,
    sizedBaseQty: params.decision.sizing.finalBaseQty,
    limitPrice: params.decision.sizing.limitPrice,
    pythPriceUsd: params.pythFeed.priceUsd,
    pythConfBps: params.pythFeed.confBps,
    pythFeedIdHex: params.pythFeed.feedIdHex,
    marketPda: params.book.marketPda,
  });

  const decisionDigestBytes = await sha256Bytes(preimage);
  const decisionDigestHex = await sha256Hex(preimage);

  const envelope: CanonicalAuditEnvelope = {
    v: 'liveedge-solana/v1',
    market: params.book.symbol,
    venue: params.book.venue,
    dir: params.impulse.direction,
    style: params.orderStyle,
    riskCapUsdc: params.decision.sizing.fixedRiskCapUsdc,
    stopBps: params.decision.sizing.stopDistanceBps,
    notionalUsdc: params.decision.sizing.finalSizedNotionalUsdc,
    qty: params.decision.sizing.finalBaseQty,
    limitPrice: params.decision.sizing.limitPrice,
    pythPrice: Number(params.pythFeed.priceUsd.toFixed(4)),
    pythConfBps: params.pythFeed.confBps,
    pythAcc: params.pythFeed.priceUpdateAccount,
    marketPda: params.book.marketPda,
    digest: decisionDigestHex.slice(0, 24),
  };

  const memoBytes = new TextEncoder().encode(JSON.stringify(envelope));
  const instruction = new TransactionInstruction({
    programId: new PublicKey(SPL_MEMO_V2_PROGRAM_ID),
    keys: [{ pubkey: params.trader, isSigner: true, isWritable: false }],
    data: toInstructionData(memoBytes),
  });

  return {
    instruction,
    envelope,
    decisionDigestHex,
    decisionDigestBytes,
  };
}
