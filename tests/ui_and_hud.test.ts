import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveEdgeSolanaApp } from '../src/ui/app';

describe('LiveEdge Solana Terminal UI & Optional Even G2 HUD Integration', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
      url: 'http://127.0.0.1:4174/',
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('HTMLButtonElement', dom.window.HTMLButtonElement);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      })
    );
  });

  it('mounts cleanly, blocks HUD alerts on trap scenarios, and executes via G2 temple 2xTap on PASS scenarios', async () => {
    const root = document.querySelector<HTMLElement>('#app')!;
    const app = new LiveEdgeSolanaApp(root);
    await app.mount();

    // Default scenario `sol-perp-breakout` is PASS -> G2 waveguide is armed
    expect(root.textContent).toContain('ALL 8 GATES GREEN');
    const wgInitial = root.querySelector('#g2-solana-waveguide')!;
    expect(wgInitial.textContent).toContain('2xTAP');

    // Switch to `btc-cpi-conf-blowout` -> button locks & G2 waveguide suppresses alert
    app.selectScenario('btc-cpi-conf-blowout');
    const execBtnLocked = root.querySelector<HTMLButtonElement>('#btn-execute-solana')!;
    expect(execBtnLocked.disabled).toBe(true);
    expect(execBtnLocked.textContent).toContain('ORACLE_CONFIDENCE_TOO_WIDE');
    expect(root.querySelector('#g2-solana-waveguide')!.textContent).toContain(
      'SILENT BLOCK ACTIVE'
    );

    // Switch to `pm-clutch-repricing` (Prediction Market PASS) & toggle order style via HUD Tap
    app.selectScenario('pm-clutch-repricing');
    root.querySelector<HTMLButtonElement>('#btn-hud-tap')!.click();
    expect(root.querySelector('#g2-solana-waveguide')!.textContent).toContain(
      'POST_ONLY'
    );

    // Execute via G2 HUD Double-Tap and verify receipt renders with Devnet Explorer link
    const receipt = await app.executeCurrentImpulse();
    expect(receipt).not.toBeNull();
    expect(receipt!.marketSymbol).toBe('SOL-80-DEC-BET');
    expect(receipt!.ed25519Verified).toBe(true);
    expect(root.querySelector('#tx-signature-box')!.textContent!.length).toBeGreaterThan(40);
    expect(root.innerHTML).toContain('explorer.solana.com/tx/inspector?cluster=devnet');

    // Regression: stepping 150 frames on thin-depth trap must NEVER compound top ask notional
    for (let f = 0; f < 150; f++) {
      await app.stepDeterministicDemoReel(19_200 + f * 20);
    }
    expect(window.__solanaDemoState?.scenarioId).toBe('pm-thin-depth-trap');
    expect(window.__solanaDemoState?.passed).toBe(false);
    expect(root.textContent).toContain('$5'); // top ask stays ~$4.50, never compounds to $25+
  });
});
