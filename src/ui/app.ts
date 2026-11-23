import type {
  HudCompanionSnapshot,
  OrderExecutionStyle,
  PythFeedSnapshot,
  ScenarioId,
  SolanaExecutionReceipt,
  SolanaRiskGateDecision,
  SupportedAsset,
} from '../engine/types';
import {
  DEFAULT_SOLANA_RISK_CONFIG,
  evaluateSolanaRiskGate,
} from '../engine/solanaRiskGate';
import { G2SolanaCompanionController } from '../hud/g2CompanionController';
import {
  PYTH_CANONICAL_FEEDS,
  fetchLivePythFeeds,
} from '../oracle/pythHermesGuard';
import {
  executeRiskGatedSolanaOrder,
  type SolanaWalletStandardProvider,
} from '../solana/devnetExecutor';
import {
  ALL_SCENARIO_IDS,
  buildScenarioBundle,
  type ScenarioBundle,
} from '../venues/marketDataClient';

export interface SolanaDemoAutomationState {
  actIndex: number;
  scenarioId: ScenarioId;
  passed: boolean;
  rejectionCode: string;
  hudMode: string;
  receiptCount: number;
  lastTxSignature: string;
}

declare global {
  interface Window {
    solana?: SolanaWalletStandardProvider;
    __solanaDemoState?: SolanaDemoAutomationState;
    __stepSolanaDemoAtTimeMs?: (elapsedMs: number) => Promise<void>;
  }
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class LiveEdgeSolanaApp {
  private root: HTMLElement;
  private liveFeeds: Record<SupportedAsset, PythFeedSnapshot>;
  private activeScenarioId: ScenarioId = 'sol-perp-breakout';
  private activeBundle: ScenarioBundle;
  private activeDecision: SolanaRiskGateDecision;
  private requestedRiskUsdc = 10.0;
  private orderStyle: OrderExecutionStyle = 'IOC_LIMIT';
  private connectedWalletAddress: string | null = null;
  private receipts: SolanaExecutionReceipt[] = [];
  private isExecuting = false;
  private hud: G2SolanaCompanionController;
  private hudSnapshot: HudCompanionSnapshot;
  private demoSubtitle = '';
  private demoActIndex = 0;
  private lastSteppedAct = -1;
  private devnetSlot = 525506120;

  constructor(root: HTMLElement) {
    this.root = root;
    this.liveFeeds = {
      SOL: {
        asset: 'SOL',
        symbol: 'SOL/USD',
        feedIdHex: PYTH_CANONICAL_FEEDS.SOL.feedIdHex,
        priceUpdateAccount: PYTH_CANONICAL_FEEDS.SOL.solanaPriceUpdateAccount,
        priceUsd: 74.08,
        confUsd: 0.021,
        confBps: 2.8,
        emaPriceUsd: 74.02,
        exponent: -8,
        publishTimeSec: Math.floor(Date.now() / 1000) - 2,
        ageMs: 1800,
        postedSlot: 473026120,
        spotReferenceUsd: 74.58,
        spotDislocationBps: 68.0,
        source: 'SOLANA_ONCHAIN_RECEIVER',
      },
      BTC: {
        asset: 'BTC',
        symbol: 'BTC/USD',
        feedIdHex: PYTH_CANONICAL_FEEDS.BTC.feedIdHex,
        priceUpdateAccount: PYTH_CANONICAL_FEEDS.BTC.solanaPriceUpdateAccount,
        priceUsd: 68140.5,
        confUsd: 14.2,
        confBps: 2.1,
        emaPriceUsd: 68115.0,
        exponent: -8,
        publishTimeSec: Math.floor(Date.now() / 1000) - 3,
        ageMs: 2800,
        postedSlot: 473026118,
        spotReferenceUsd: 68195.0,
        spotDislocationBps: 8.0,
        source: 'SOLANA_ONCHAIN_RECEIVER',
      },
      ETH: {
        asset: 'ETH',
        symbol: 'ETH/USD',
        feedIdHex: PYTH_CANONICAL_FEEDS.ETH.feedIdHex,
        priceUpdateAccount: PYTH_CANONICAL_FEEDS.ETH.solanaPriceUpdateAccount,
        priceUsd: 2128.4,
        confUsd: 0.85,
        confBps: 4.0,
        emaPriceUsd: 2126.9,
        exponent: -8,
        publishTimeSec: Math.floor(Date.now() / 1000) - 4,
        ageMs: 3600,
        postedSlot: 473026115,
        spotReferenceUsd: 2130.1,
        spotDislocationBps: 8.0,
        source: 'SOLANA_ONCHAIN_RECEIVER',
      },
    };

    this.hud = new G2SolanaCompanionController({
      onDoubleTapExecute: async () => {
        await this.executeCurrentImpulse();
      },
      onTapToggleStyle: (nextStyle) => {
        this.orderStyle = nextStyle;
        this.render();
      },
      onSwipeDismiss: () => {
        this.hudSnapshot = this.hud.getSnapshot();
        this.render();
      },
      onSnapshotChanged: (snap) => {
        this.hudSnapshot = snap;
      },
    });
    this.hudSnapshot = this.hud.getSnapshot();

    this.activeBundle = buildScenarioBundle(
      this.activeScenarioId,
      this.liveFeeds,
      Date.now(),
      this.devnetSlot
    );
    this.activeDecision = evaluateSolanaRiskGate(
      this.activeBundle.impulse,
      this.activeBundle.pythFeed,
      this.activeBundle.orderbook,
      this.requestedRiskUsdc
    );
    this.hud.presentImpulseDecision(
      this.activeBundle.impulse,
      this.activeBundle.pythFeed,
      this.activeDecision
    );
  }

  public async mount(): Promise<void> {
    this.render();
    window.__stepSolanaDemoAtTimeMs = async (ms: number) => {
      await this.stepDeterministicDemoReel(ms);
    };
    this.syncGlobalDemoState();

    // Refresh live Solana Pyth PriceUpdateV2 feeds asynchronously
    fetchLivePythFeeds({ timeoutMs: 3800 })
      .then((feeds) => {
        this.liveFeeds = feeds;
        if (this.lastSteppedAct === -1) {
          this.selectScenario(this.activeScenarioId);
        }
      })
      .catch(() => {
        // Keep initial calibrated snapshot if offline
      });

    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1' && params.get('manualStep') !== '1') {
      this.startInteractiveDemoReel();
    }
  }

  public selectScenario(scenarioId: ScenarioId, fixedNowMs?: number): void {
    const nowMs = fixedNowMs ?? Date.now();
    this.activeScenarioId = scenarioId;
    this.activeBundle = buildScenarioBundle(
      scenarioId,
      this.liveFeeds,
      nowMs,
      this.devnetSlot
    );
    this.recomputeDecision(nowMs);
    this.hud.setOrderStyle(this.orderStyle);
    this.hud.presentImpulseDecision(
      this.activeBundle.impulse,
      this.activeBundle.pythFeed,
      this.activeDecision
    );
    this.syncGlobalDemoState();
    this.render();
  }

  private recomputeDecision(nowMs = Date.now()): void {
    this.activeDecision = evaluateSolanaRiskGate(
      this.activeBundle.impulse,
      this.activeBundle.pythFeed,
      this.activeBundle.orderbook,
      this.requestedRiskUsdc,
      DEFAULT_SOLANA_RISK_CONFIG,
      nowMs
    );
  }

  public async connectBrowserWallet(): Promise<void> {
    if (!window.solana) {
      this.demoSubtitle =
        'No injected Solana browser wallet detected — running cryptographic Ed25519 + Solana Devnet BPF simulation mode.';
      this.render();
      return;
    }
    try {
      const res = await window.solana.connect();
      this.connectedWalletAddress = res.publicKey.toBase58();
      this.demoSubtitle = `Connected Solana Wallet: ${this.connectedWalletAddress.slice(0, 6)}...${this.connectedWalletAddress.slice(-4)} (Devnet)`;
      this.render();
    } catch (err) {
      this.demoSubtitle = `Wallet connection cancelled: ${(err as Error).message}`;
      this.render();
    }
  }

  public async executeCurrentImpulse(): Promise<SolanaExecutionReceipt | null> {
    if (!this.activeDecision.passed || this.isExecuting) {
      return null;
    }
    this.isExecuting = true;
    this.render();

    try {
      const receipt = await executeRiskGatedSolanaOrder({
        impulse: this.activeBundle.impulse,
        pythFeed: this.activeBundle.pythFeed,
        book: this.activeBundle.orderbook,
        decision: this.activeDecision,
        orderStyle: this.orderStyle,
        walletProvider: this.connectedWalletAddress
          ? window.solana
          : undefined,
      });
      this.receipts = [receipt, ...this.receipts].slice(0, 6);
      this.devnetSlot = receipt.devnetSlot;
      this.hud.presentExecutionReceipt(receipt);
      this.syncGlobalDemoState();
      return receipt;
    } finally {
      this.isExecuting = false;
      this.render();
    }
  }

  private applyMicroBookPulse(elapsedMs: number): void {
    const bucket = Math.floor(elapsedMs / 250);
    this.devnetSlot = 525506120 + Math.floor(elapsedMs / 400);
    const wave = 1 + Math.sin(bucket * 0.7) * 0.035;
    this.activeBundle.orderbook.asks = this.activeBundle.orderbook.asks.map(
      (a, idx) => ({
        ...a,
        notionalUsdc: Number(
          (a.notionalUsdc * (idx === 0 ? wave : 1)).toFixed(2)
        ),
      })
    );
  }

  /**
   * Frame-accurate 50-second (6-Act) deterministic stepper for 1920x1080 30fps HD video capture.
   */
  public async stepDeterministicDemoReel(elapsedMs: number): Promise<void> {
    const sec = elapsedMs / 1000;
    const baseNow = 1795456000000 + Math.floor(elapsedMs);
    this.applyMicroBookPulse(elapsedMs);

    if (sec < 7.5) {
      if (this.lastSteppedAct !== 1) {
        this.lastSteppedAct = 1;
        this.demoActIndex = 1;
        this.requestedRiskUsdc = 10.0;
        this.orderStyle = 'IOC_LIMIT';
        this.selectScenario('sol-perp-breakout', baseNow);
      }
      this.demoSubtitle =
        'Act 1/6 · Sub-Second Pyth Solana Receiver Telemetry (SOL/USD ±2.8 bps) & Drift v2 Perp Depth';
    } else if (sec < 15.0) {
      if (this.lastSteppedAct !== 2) {
        this.lastSteppedAct = 2;
        this.demoActIndex = 2;
        this.selectScenario('btc-cpi-conf-blowout', baseNow);
      }
      this.demoSubtitle =
        'Act 2/6 · Macro CPI Whipsaw: Pyth ±conf Spikes to 48.5 bps (>30 bps Cap) -> Fail-Closed BLOCKED';
    } else if (sec < 22.5) {
      if (this.lastSteppedAct !== 3) {
        this.lastSteppedAct = 3;
        this.demoActIndex = 3;
        this.selectScenario('eth-stale-oracle-trap', baseNow);
      }
      if (sec >= 19.0 && this.activeScenarioId !== 'pm-thin-depth-trap') {
        this.selectScenario('pm-thin-depth-trap', baseNow);
      }
      this.demoSubtitle =
        sec < 19.0
          ? 'Act 3/6 · Stale Static Push Shard (128s > 45s SLA) -> ORACLE_STALE_FRAME Intercepted'
          : 'Act 3/6 · Prediction Market Thin-Liquidity Trap ($11.03 Ask Depth < $25 Floor) -> BLOCKED';
    } else if (sec < 33.5) {
      if (this.lastSteppedAct !== 4) {
        this.lastSteppedAct = 4;
        this.demoActIndex = 4;
        this.orderStyle = 'IOC_LIMIT';
        this.selectScenario('sol-perp-breakout', baseNow);
      }
      if (sec >= 26.5 && this.receipts.length === 0) {
        await this.executeCurrentImpulse();
      }
      this.demoSubtitle =
        sec < 26.5
          ? 'Act 4/6 · Valid SOL-PERP Impulse (+68 bps): $10 Fixed Risk Cap Sizes $800 Notional (1.25% Stop)'
          : 'Act 4/6 · Atomic V0 Tx Signed & Verified on Solana Devnet BPF VM (Ed25519 + 127k CU Logs)';
    } else if (sec < 40.5) {
      if (this.lastSteppedAct !== 5) {
        this.lastSteppedAct = 5;
        this.demoActIndex = 5;
        this.selectScenario('sol-adverse-whale-trap', baseNow);
      }
      this.demoSubtitle =
        'Act 5/6 · Pre-Headline Informed Whale Dump ($2,840 Short Sweep) -> WHALE_TOXICITY_ALERT Blocked';
    } else {
      if (this.lastSteppedAct !== 6) {
        this.lastSteppedAct = 6;
        this.demoActIndex = 6;
        this.orderStyle = 'POST_ONLY';
        this.selectScenario('pm-clutch-repricing', baseNow);
      }
      if (sec >= 43.2 && this.orderStyle !== 'IOC_LIMIT') {
        await this.hud.triggerGesture('TAP');
      }
      if (sec >= 45.0 && this.receipts.length < 2) {
        await this.hud.triggerGesture('DOUBLE_TAP');
      }
      this.demoSubtitle =
        sec < 45.0
          ? 'Act 6/6 · Solana BET Prediction Lag (+6.8c Edge): G2 Smart-Glasses HUD Armed ($10 Binary Cap)'
          : 'Act 6/6 · Temple 2xTAP Executes Bounded Solana Devnet Order — Verify Signature on Solana Explorer';
    }

    this.syncGlobalDemoState();
    this.render();
  }

  public startInteractiveDemoReel(): void {
    const start = performance.now();
    this.lastSteppedAct = -1;
    this.receipts = [];
    const timer = setInterval(async () => {
      const elapsed = performance.now() - start;
      if (elapsed > 50_000) {
        clearInterval(timer);
        this.demoSubtitle = '';
        this.render();
        return;
      }
      await this.stepDeterministicDemoReel(elapsed);
    }, 350);
  }

  private syncGlobalDemoState(): void {
    window.__solanaDemoState = {
      actIndex: this.demoActIndex,
      scenarioId: this.activeScenarioId,
      passed: this.activeDecision.passed,
      rejectionCode: this.activeDecision.rejectionCode,
      hudMode: this.hudSnapshot.mode,
      receiptCount: this.receipts.length,
      lastTxSignature: this.receipts[0]?.txSignature || '',
    };
  }

  private render(): void {
    const b = this.activeBundle;
    const d = this.activeDecision;
    const s = d.sizing;
    const isPm = b.orderbook.venue !== 'SOLANA_DRIFT_PERP';
    const priceDecimals = isPm ? 4 : 2;
    const maxBookNotional = Math.max(
      1,
      ...b.orderbook.asks.map((x) => x.notionalUsdc),
      ...b.orderbook.bids.map((x) => x.notionalUsdc)
    );

    const latestReceipt = this.receipts[0] || null;

    const pythRibbonHtml = (['SOL', 'BTC', 'ETH'] as SupportedAsset[])
      .map((asset) => {
        const f =
          b.pythFeed.asset === asset ? b.pythFeed : this.liveFeeds[asset];
        const ageSec = (f.ageMs / 1000).toFixed(1);
        const freshClass = f.ageMs <= 45_000 && f.confBps <= 30 ? 'fresh' : 'stale';
        return `
          <div class="pyth-pill ${freshClass}">
            <span class="pyth-sym">${escapeHtml(f.symbol)}</span>
            <span>$${f.priceUsd.toFixed(asset === 'SOL' ? 3 : 2)}</span>
            <span class="pyth-conf">±${f.confBps.toFixed(1)}bps</span>
            <span class="pyth-age">${ageSec}s</span>
          </div>
        `;
      })
      .join('');

    const scenarioCardsHtml = ALL_SCENARIO_IDS.map((id) => {
      const sample = buildScenarioBundle(id, this.liveFeeds);
      const active = id === this.activeScenarioId ? 'active' : '';
      const passBadge =
        sample.expectedOutcome === 'PASS'
          ? '<span class="badge-pass">8/8 PASS</span>'
          : '<span class="badge-block">FAIL-CLOSED</span>';
      return `
        <button type="button" class="scenario-card ${active}" data-scenario="${id}">
          <div class="scenario-top">
            <span class="scenario-sym">${escapeHtml(sample.badge)}</span>
            ${passBadge}
          </div>
          <div class="scenario-desc">${escapeHtml(sample.impulse.title)}</div>
        </button>
      `;
    }).join('');

    const asksHtml = [...b.orderbook.asks]
      .slice(0, 4)
      .reverse()
      .map((lvl) => {
        const pct = Math.min(100, Math.round((lvl.notionalUsdc / maxBookNotional) * 100));
        return `
          <div class="book-row ask">
            <div class="book-bar" style="width:${pct}%"></div>
            <span class="book-price">${lvl.price.toFixed(priceDecimals)}</span>
            <span>${lvl.sizeBase.toFixed(2)}</span>
            <span style="text-align:right">$${lvl.notionalUsdc.toFixed(0)}</span>
          </div>
        `;
      })
      .join('');

    const bidsHtml = b.orderbook.bids
      .slice(0, 4)
      .map((lvl) => {
        const pct = Math.min(100, Math.round((lvl.notionalUsdc / maxBookNotional) * 100));
        return `
          <div class="book-row bid">
            <div class="book-bar" style="width:${pct}%"></div>
            <span class="book-price">${lvl.price.toFixed(priceDecimals)}</span>
            <span>${lvl.sizeBase.toFixed(2)}</span>
            <span style="text-align:right">$${lvl.notionalUsdc.toFixed(0)}</span>
          </div>
        `;
      })
      .join('');

    const gateItems: Array<{ label: string; ok: boolean; detail: string }> = [
      {
        label: '1. Fixed Risk Cap',
        ok: d.checks.riskCapLocked,
        detail: `$${s.impliedMaxLossUsdc.toFixed(2)} <= $${DEFAULT_SOLANA_RISK_CONFIG.fixedRiskCapUsdc.toFixed(0)}U`,
      },
      {
        label: '2. Pyth Freshness',
        ok: d.checks.oracleFreshOk,
        detail: `${(d.oracleAgeMs / 1000).toFixed(1)}s <= 45s`,
      },
      {
        label: '3. Pyth ±Conf SLA',
        ok: d.checks.oracleConfOk,
        detail: `${d.pythConfBps.toFixed(1)} <= 30bps`,
      },
      {
        label: '4. Whale / CuiBono',
        ok: d.checks.whaleSafeOk,
        detail: `$${b.impulse.adverseWhaleFlowUsdc.toFixed(0)} < $1k`,
      },
      {
        label: '5. Venue Spread',
        ok: d.checks.spreadOk,
        detail: `${d.spreadBps.toFixed(1)} bps`,
      },
      {
        label: '6. Top Ask Depth',
        ok: d.checks.depthOk,
        detail: `$${d.availableDepthUsdc.toFixed(0)} >= $25`,
      },
      {
        label: '7. VWAP Slippage',
        ok: d.checks.slippageOk,
        detail: `${s.slippageBps.toFixed(1)} bps`,
      },
      {
        label: '8. Impulse Edge',
        ok: d.checks.edgeOk,
        detail: `+${d.edgeBps.toFixed(1)} bps`,
      },
    ];

    const gatesHtml = gateItems
      .map(
        (g) => `
        <div class="gate-chip ${g.ok ? 'ok' : 'fail'}">
          <span class="gate-name">${escapeHtml(g.label)}</span>
          <span class="gate-state">${g.ok ? 'PASS' : 'BLOCK'} · ${escapeHtml(g.detail)}</span>
        </div>
      `
      )
      .join('');

    const receiptHtml = latestReceipt
      ? `
        <div class="receipt-card" id="latest-solana-receipt">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="badge-pass">${escapeHtml(latestReceipt.broadcastStatus)}</span>
            <span style="font-family:var(--font-mono);font-size:11px;color:var(--pyth-cyan)">
              Ed25519 Verified: ${latestReceipt.ed25519Verified ? 'TRUE' : 'FALSE'} · Slot ${latestReceipt.devnetSlot}
            </span>
          </div>
          <div class="kv-list">
            <div class="kv-item">
              <span>Order &amp; Sized Cap</span>
              <span class="kv-val highlight">${escapeHtml(latestReceipt.marketSymbol)} ${escapeHtml(latestReceipt.direction)} (${escapeHtml(latestReceipt.orderStyle)}) · $${latestReceipt.sizedNotionalUsdc.toFixed(2)}</span>
            </div>
            <div class="kv-item">
              <span>Devnet Trader Signer</span>
              <span class="kv-val">${escapeHtml(latestReceipt.traderPubkey.slice(0, 10))}...${escapeHtml(latestReceipt.traderPubkey.slice(-8))}</span>
            </div>
            <div class="kv-item">
              <span>Compute Units / Priority</span>
              <span class="kv-val">${latestReceipt.computeUnitsConsumed.toLocaleString()} CU @ ${latestReceipt.priorityFeeMicroLamports} µLamports</span>
            </div>
          </div>
          <div>
            <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:3px">Solana V0 Tx Signature (Click Copy / Verify):</div>
            <div class="sig-box" id="tx-signature-box">${escapeHtml(latestReceipt.txSignature)}</div>
          </div>
          <div class="bpf-logs">${latestReceipt.bpfLogs.map((l) => escapeHtml(l)).join('<br/>')}</div>
          <div class="explorer-links">
            <a class="explorer-link" href="${escapeHtml(latestReceipt.explorerInspectorUrl)}" target="_blank" rel="noopener noreferrer">
              🔍 Verify V0 Tx on Solana Explorer (Devnet)
            </a>
            <a class="explorer-link" href="${escapeHtml(latestReceipt.explorerOracleAccountUrl)}" target="_blank" rel="noopener noreferrer">
              📡 Pyth Receiver Account
            </a>
            <a class="explorer-link" href="${escapeHtml(latestReceipt.explorerMarketPdaUrl)}" target="_blank" rel="noopener noreferrer">
              📊 Drift Market PDA
            </a>
          </div>
        </div>
      `
      : `
        <div class="controls-box" style="border-style:dashed;text-align:center;padding:16px;color:var(--text-muted)">
          Select a PASS scenario and click <strong>Execute Atomic V0 Devnet Tx</strong> (or double-tap the G2 HUD) to sign &amp; verify on Solana Devnet BPF VM.
        </div>
      `;

    const lat = latestReceipt?.latencyMs ?? {
      detectToOracleMs: 4,
      riskGateMs: 2,
      txBuildSignMs: 3,
      solanaRpcConfirmMs: 340,
      totalEndToEndMs: 349,
    };

    this.root.innerHTML = `
      <div class="terminal-shell">
        <header class="topbar">
          <div class="brand-group">
            <div class="brand-mark">LE</div>
            <div>
              <div class="brand-title">LiveEdge Solana · Risk-Gated Impulse Execution Terminal</div>
              <div class="brand-sub">Pyth Hermes &amp; PriceUpdateV2 Guard · Fixed-Loss Sizer · Drift v2 Perps &amp; Prediction Markets</div>
            </div>
          </div>
          <div class="pyth-ribbon">${pythRibbonHtml}</div>
          <div class="topbar-actions">
            <span class="slot-badge">DEVNET SLOT ${this.devnetSlot.toLocaleString()}</span>
            <button type="button" class="btn btn-accent" id="btn-connect-wallet">
              ${this.connectedWalletAddress ? `🟢 ${escapeHtml(this.connectedWalletAddress.slice(0, 4))}..${escapeHtml(this.connectedWalletAddress.slice(-4))}` : 'Connect Devnet Wallet'}
            </button>
            <button type="button" class="btn" id="btn-replay-demo">▶ 50s Demo Reel</button>
          </div>
        </header>

        <main class="workspace-grid">
          <!-- Column 1: Impulse Feed & Execution Controls -->
          <section class="panel">
            <div class="panel-header">
              <span class="panel-title">① Live Impulse &amp; Trap Matrix</span>
              <span class="panel-tag">6 SCENARIOS</span>
            </div>
            <div class="scenario-list">${scenarioCardsHtml}</div>

            <div class="controls-box">
              <div class="control-row">
                <span class="control-label">Fixed Max-Loss Budget</span>
                <div class="seg-group">
                  ${[5, 10]
                    .map(
                      (val) => `
                    <button type="button" class="seg-btn ${this.requestedRiskUsdc === val ? 'active' : ''}" data-risk="${val}">
                      $${val}.00 USDC
                    </button>
                  `
                    )
                    .join('')}
                </div>
              </div>
              <div class="control-row">
                <span class="control-label">Bounded Order Mode</span>
                <div class="seg-group">
                  <button type="button" class="seg-btn ${this.orderStyle === 'IOC_LIMIT' ? 'active' : ''}" data-style="IOC_LIMIT">IOC_LIMIT</button>
                  <button type="button" class="seg-btn ${this.orderStyle === 'POST_ONLY' ? 'active' : ''}" data-style="POST_ONLY">POST_ONLY</button>
                </div>
              </div>
              <button
                type="button"
                id="btn-execute-solana"
                class="btn btn-primary execute-btn"
                ${!d.passed || this.isExecuting ? 'disabled' : ''}
              >
                ${
                  this.isExecuting
                    ? '⏳ Signing & Verifying on Solana Devnet...'
                    : d.passed
                      ? `⚡ Execute Atomic V0 Devnet Tx ($${s.finalSizedNotionalUsdc.toFixed(0)} · Max Loss $${s.impliedMaxLossUsdc.toFixed(2)})`
                      : `🛑 Execution Locked (${escapeHtml(d.rejectionCode)})`
                }
              </button>
            </div>
          </section>

          <!-- Column 2: Venue Orderbook, Fixed-Loss Sizer & 8-Gate Matrix -->
          <section class="panel">
            <div class="panel-header">
              <span class="panel-title">② ${escapeHtml(b.orderbook.title)}</span>
              <span class="panel-tag">${escapeHtml(b.orderbook.sourceLabel)}</span>
            </div>

            <div class="verdict-banner ${d.passed ? 'pass' : 'block'}" id="risk-verdict-banner">
              <span>${escapeHtml(d.reason)}</span>
              <span>${d.passed ? 'READY' : 'INTERCEPTED'}</span>
            </div>

            <div class="narrative-box">${escapeHtml(b.impulse.narrative)}</div>

            <div class="mid-split">
              <div class="book-box">
                <div class="sub-heading">
                  <span>Venue L2 Depth</span>
                  <span>Ask /Qty /USDC</span>
                </div>
                ${asksHtml}
                <div class="book-mid">
                  MID ${b.orderbook.midPrice.toFixed(priceDecimals)} · SPREAD ${d.spreadBps.toFixed(1)} bps
                </div>
                ${bidsHtml}
              </div>

              <div class="sizer-box">
                <div class="sub-heading">
                  <span>Fixed-Loss Sizer (以损定仓)</span>
                  <span>ATOMIC GUARD</span>
                </div>
                <div class="kv-list">
                  <div class="kv-item">
                    <span>Locked Max Loss</span>
                    <span class="kv-val highlight">$${s.fixedRiskCapUsdc.toFixed(2)} USDC</span>
                  </div>
                  <div class="kv-item">
                    <span>Invalidation Stop</span>
                    <span class="kv-val">${(s.stopDistanceBps / 100).toFixed(2)}% (${s.stopDistanceBps} bps)</span>
                  </div>
                  <div class="kv-item">
                    <span>Risk-Derived Cap</span>
                    <span class="kv-val">$${s.rawRiskSizedNotionalUsdc.toFixed(2)}</span>
                  </div>
                  <div class="kv-item">
                    <span>Final Sized Notional</span>
                    <span class="kv-val highlight">$${s.finalSizedNotionalUsdc.toFixed(2)} (${s.finalBaseQty.toFixed(3)})</span>
                  </div>
                  <div class="kv-item">
                    <span>Bounded Limit Price</span>
                    <span class="kv-val">${s.limitPrice.toFixed(priceDecimals)}</span>
                  </div>
                  <div class="kv-item">
                    <span>Simulated VWAP Fill</span>
                    <span class="kv-val">${s.vwapFillPrice.toFixed(priceDecimals)} (${s.slippageBps.toFixed(1)} bps)</span>
                  </div>
                  <div class="kv-item">
                    <span>Expected Impulse EV</span>
                    <span class="kv-val highlight">${d.expectedValueUsdc >= 0 ? '+' : ''}$${d.expectedValueUsdc.toFixed(2)} USDC</span>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div class="sub-heading"><span>8-Gate Fail-Closed On-Chain &amp; Microstructure Checklist</span><span>BLIND MARKET ORDERS FORBIDDEN</span></div>
              <div class="gates-grid">${gatesHtml}</div>
            </div>
          </section>

          <!-- Column 3: Solana 400ms Pipeline, Explorer Verification & Even G2 HUD -->
          <section class="panel">
            <div class="panel-header">
              <span class="panel-title">③ Solana 400ms Execution &amp; G2 HUD</span>
              <span class="panel-tag">DEVNET VERIFIABLE</span>
            </div>

            <div class="latency-bar">
              <div class="lat-step">
                <div class="lat-ms">${lat.detectToOracleMs}ms</div>
                <div class="lat-lbl">Pyth Read</div>
              </div>
              <div class="lat-step">
                <div class="lat-ms">${lat.riskGateMs}ms</div>
                <div class="lat-lbl">8-Gate Sizer</div>
              </div>
              <div class="lat-step">
                <div class="lat-ms">${lat.txBuildSignMs}ms</div>
                <div class="lat-lbl">V0 Ed25519</div>
              </div>
              <div class="lat-step">
                <div class="lat-ms">${lat.solanaRpcConfirmMs}ms</div>
                <div class="lat-lbl">Solana Slot</div>
              </div>
            </div>

            ${receiptHtml}

            <div class="controls-box">
              <div class="sub-heading" style="margin-bottom:4px">
                <span>Optional Even G2 Waveguide HUD (#509 Link)</span>
                <span>576x288 MICRO-LED</span>
              </div>
              <div class="waveguide-frame" id="g2-solana-waveguide">
                <div class="wg-top">${escapeHtml(this.hudSnapshot.topBarText)}</div>
                <div class="wg-center">
                  ${
                    this.hudSnapshot.alertBodyText
                      ? escapeHtml(this.hudSnapshot.alertBodyText)
                      : 'AMBIENT CLEAR FIELD OF VIEW (NOISE SUPPRESSED)'
                  }
                </div>
                <div class="wg-foot">${escapeHtml(this.hudSnapshot.footerHintText)}</div>
              </div>
              <div class="gesture-row">
                <button type="button" class="btn" id="btn-hud-tap" style="flex:1">👆 Tap (${escapeHtml(this.orderStyle)})</button>
                <button type="button" class="btn btn-primary" id="btn-hud-doubletap" style="flex:1.3" ${this.hudSnapshot.mode !== 'IMPULSE_ALERT' ? 'disabled' : ''}>⚡ 2xTap Execute</button>
                <button type="button" class="btn" id="btn-hud-swipe" style="flex:1">👋 Swipe</button>
              </div>
            </div>
          </section>
        </main>

        ${
          this.demoSubtitle
            ? `<div class="subtitle-overlay">${escapeHtml(this.demoSubtitle)}</div>`
            : ''
        }
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents(): void {
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-scenario]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const sc = btn.dataset.scenario as ScenarioId;
          this.demoSubtitle = '';
          this.selectScenario(sc);
        });
      });

    this.root
      .querySelectorAll<HTMLButtonElement>('[data-risk]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          this.requestedRiskUsdc = Number(btn.dataset.risk || '10');
          this.selectScenario(this.activeScenarioId);
        });
      });

    this.root
      .querySelectorAll<HTMLButtonElement>('[data-style]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          this.orderStyle =
            btn.dataset.style === 'POST_ONLY' ? 'POST_ONLY' : 'IOC_LIMIT';
          this.hud.setOrderStyle(this.orderStyle);
          this.render();
        });
      });

    this.root
      .querySelector('#btn-execute-solana')
      ?.addEventListener('click', () => {
        void this.executeCurrentImpulse();
      });

    this.root
      .querySelector('#btn-connect-wallet')
      ?.addEventListener('click', () => {
        void this.connectBrowserWallet();
      });

    this.root
      .querySelector('#btn-replay-demo')
      ?.addEventListener('click', () => {
        this.startInteractiveDemoReel();
      });

    this.root.querySelector('#btn-hud-tap')?.addEventListener('click', () => {
      void this.hud.triggerGesture('TAP');
    });
    this.root
      .querySelector('#btn-hud-doubletap')
      ?.addEventListener('click', () => {
        void this.hud.triggerGesture('DOUBLE_TAP');
      });
    this.root.querySelector('#btn-hud-swipe')?.addEventListener('click', () => {
      void this.hud.triggerGesture('SWIPE');
    });
  }
}
