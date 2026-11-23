import type {
  HudCompanionSnapshot,
  HudWaveguideMode,
  ImpulseSignal,
  OrderExecutionStyle,
  PythFeedSnapshot,
  SolanaExecutionReceipt,
  SolanaRiskGateDecision,
} from '../engine/types';

export const G2_WAVEGUIDE_WIDTH = 576;
export const G2_WAVEGUIDE_HEIGHT = 288;

export interface HudCompanionCallbacks {
  onDoubleTapExecute?: () => Promise<void> | void;
  onTapToggleStyle?: (nextStyle: OrderExecutionStyle) => void;
  onSwipeDismiss?: () => void;
  onSnapshotChanged?: (snapshot: HudCompanionSnapshot) => void;
}

/**
 * Optional Smart-Glasses Companion View (linking LiveEdge Even G2 HUD #509 with
 * Solana 400ms Perps & Prediction Markets execution).
 * Renders within the strict 576x288 micro-LED optical waveguide geometry:
 * - `IDLE_BAR`: Minimal dim top bar (`SOL $74.05 ±2.8bps | SLOT 525506120`).
 * - `IMPULSE_ALERT`: Pops ONLY when all 8 Solana risk gates pass; silent block on traps!
 * - `TX_RECEIPT`: Displays confirmed Solana Devnet signature prefix & bounded max loss.
 */
export class G2SolanaCompanionController {
  private mode: HudWaveguideMode = 'IDLE_BAR';
  private orderStyle: OrderExecutionStyle = 'IOC_LIMIT';
  private snapshot: HudCompanionSnapshot;
  private callbacks: HudCompanionCallbacks;

  constructor(callbacks: HudCompanionCallbacks = {}) {
    this.callbacks = callbacks;
    this.snapshot = {
      mode: 'IDLE_BAR',
      orderStyle: 'IOC_LIMIT',
      topBarText: 'SOL-PERP $74.12 | PYTH ±2.8bps | RISK CAP $10U',
      alertBodyText: '',
      footerHintText: 'AMBIENT ZERO-OCCLUSION MODE · 576x288 WAVEGUIDE',
      updatedAtMs: Date.now(),
    };
  }

  public getSnapshot(): HudCompanionSnapshot {
    return { ...this.snapshot };
  }

  public getOrderStyle(): OrderExecutionStyle {
    return this.orderStyle;
  }

  public setOrderStyle(style: OrderExecutionStyle): void {
    this.orderStyle = style;
    this.emit({
      ...this.snapshot,
      orderStyle: style,
      footerHintText:
        this.mode === 'IMPULSE_ALERT'
          ? `[2xTAP] EXEC ${style} · [TAP] TOGGLE · [SWIPE] DISMISS`
          : this.snapshot.footerHintText,
      updatedAtMs: Date.now(),
    });
  }

  public updateIdleTelemetry(
    marketSymbol: string,
    pythFeed: PythFeedSnapshot,
    blockedBadge?: string
  ): void {
    const suffix = blockedBadge ? ` | ${blockedBadge}` : ' | 8/8 GUARD ARMED';
    this.mode = 'IDLE_BAR';
    this.emit({
      mode: 'IDLE_BAR',
      orderStyle: this.orderStyle,
      topBarText: `${marketSymbol} $${pythFeed.priceUsd.toFixed(2)} ±${pythFeed.confBps.toFixed(1)}bps${suffix}`,
      alertBodyText: '',
      footerHintText: blockedBadge
        ? 'SILENT BLOCK ACTIVE · ZERO POPUP DISTRACTION'
        : 'AMBIENT ZERO-OCCLUSION MODE · 576x288 WAVEGUIDE',
      updatedAtMs: Date.now(),
    });
  }

  public presentImpulseDecision(
    impulse: ImpulseSignal,
    pythFeed: PythFeedSnapshot,
    decision: SolanaRiskGateDecision
  ): void {
    // Fail-closed: NEVER pop waveguide alert on a blocked impulse!
    if (!decision.passed) {
      this.updateIdleTelemetry(
        impulse.marketSymbol,
        pythFeed,
        `BLOCKED:${decision.rejectionCode}`
      );
      return;
    }

    this.mode = 'IMPULSE_ALERT';
    this.emit({
      mode: 'IMPULSE_ALERT',
      orderStyle: this.orderStyle,
      topBarText: `⚡ ${impulse.marketSymbol} ${impulse.direction} | EDGE +${decision.edgeBps.toFixed(0)}bps | PYTH ±${decision.pythConfBps.toFixed(1)}bps`,
      alertBodyText: `SIZE $${decision.sizing.finalSizedNotionalUsdc.toFixed(0)} (${decision.sizing.finalBaseQty.toFixed(2)}) @ LIM ${decision.sizing.limitPrice.toFixed(3)} | MAX LOSS $${decision.sizing.impliedMaxLossUsdc.toFixed(2)}/$10U`,
      footerHintText: `[2xTAP] EXEC ${this.orderStyle} · [TAP] TOGGLE · [SWIPE] DISMISS`,
      updatedAtMs: Date.now(),
    });
  }

  public presentExecutionReceipt(receipt: SolanaExecutionReceipt): void {
    this.mode = 'TX_RECEIPT';
    const shortSig = `${receipt.txSignature.slice(0, 8)}...${receipt.txSignature.slice(-6)}`;
    this.emit({
      mode: 'TX_RECEIPT',
      orderStyle: receipt.orderStyle,
      topBarText: `✅ SOLANA DEVNET ${receipt.marketSymbol} ${receipt.orderStyle} (${receipt.latencyMs.totalEndToEndMs}ms)`,
      alertBodyText: `FILLED $${receipt.sizedNotionalUsdc.toFixed(0)} @ ${receipt.vwapFillPrice.toFixed(3)} | LOSS CAP $${receipt.impliedMaxLossUsdc.toFixed(2)} | SIG ${shortSig}`,
      footerHintText: `SLOT ${receipt.devnetSlot} · CU ${receipt.computeUnitsConsumed} · ED25519 VERIFIED`,
      updatedAtMs: Date.now(),
    });
  }

  public async triggerGesture(
    gesture: 'TAP' | 'DOUBLE_TAP' | 'SWIPE'
  ): Promise<void> {
    if (gesture === 'TAP') {
      const next: OrderExecutionStyle =
        this.orderStyle === 'IOC_LIMIT' ? 'POST_ONLY' : 'IOC_LIMIT';
      this.setOrderStyle(next);
      this.callbacks.onTapToggleStyle?.(next);
      return;
    }
    if (gesture === 'SWIPE') {
      this.mode = 'IDLE_BAR';
      this.emit({
        ...this.snapshot,
        mode: 'IDLE_BAR',
        alertBodyText: '',
        footerHintText: 'DISMISSED BY TEMPLE SWIPE · AMBIENT MODE',
        updatedAtMs: Date.now(),
      });
      this.callbacks.onSwipeDismiss?.();
      return;
    }
    if (gesture === 'DOUBLE_TAP' && this.mode === 'IMPULSE_ALERT') {
      await this.callbacks.onDoubleTapExecute?.();
    }
  }

  private emit(next: HudCompanionSnapshot): void {
    this.snapshot = next;
    this.callbacks.onSnapshotChanged?.({ ...next });
  }
}
