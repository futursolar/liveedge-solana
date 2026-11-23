#!/usr/bin/env node
/**
 * Fact 1109 High-Craft Programmatic 1080p 30fps Demo Video Recorder for LiveEdge Solana.
 * Renders all 6 choreographed acts via frame-accurate Chromium stepping (`?demo=1&manualStep=1`),
 * synthesizes dark institutional sound design (sub-pad + tactile gate locks + Devnet confirm chords),
 * and encodes H.264 `yuv420p` (`crf 18`, `+faststart`) MP4.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEMO_DIR = path.join(ROOT, 'demo');
const FRAMES_DIR = path.join(DEMO_DIR, 'frames');
const OUTPUT_MP4 = path.join(DEMO_DIR, 'liveedge-solana-demo.mp4');

function findChromiumExecutable() {
  if (
    process.env.CHROMIUM_EXECUTABLE_PATH &&
    fs.existsSync(process.env.CHROMIUM_EXECUTABLE_PATH)
  ) {
    return process.env.CHROMIUM_EXECUTABLE_PATH;
  }
  const searchRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter(Boolean);

  for (const cacheDir of searchRoots) {
    if (fs.existsSync(cacheDir)) {
      for (const entry of fs.readdirSync(cacheDir)) {
        if (entry.startsWith('chromium')) {
          const walk = (dir) => {
            for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, f.name);
              if (f.isDirectory()) {
                const hit = walk(full);
                if (hit) return hit;
              } else if (
                f.name === 'chrome-headless-shell' ||
                f.name === 'chrome'
              ) {
                return full;
              }
            }
            return null;
          };
          const found = walk(path.join(cacheDir, entry));
          if (found) return found;
        }
      }
    }
  }
  for (const sysBin of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]) {
    if (fs.existsSync(sysBin)) return sysBin;
  }
  return undefined;
}

function synthesizeCinematicSoundtrackWav(wavPath, durationSec) {
  const sampleRate = 44100;
  const totalSamples = Math.floor(sampleRate * durationSec);
  const buffer = Buffer.alloc(44 + totalSamples * 2);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + totalSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(totalSamples * 2, 40);

  const cues = [
    { t: 0.3, freqs: [440.0, 659.25], len: 0.28, amp: 0.11 },     // Act 1: Solana terminal boot
    { t: 7.55, freqs: [196.0, 207.65], len: 0.22, amp: 0.10 },    // Act 2: Pyth ±conf blowout block
    { t: 15.55, freqs: [220.0], len: 0.20, amp: 0.09 },           // Act 3a: Stale push shard block
    { t: 19.05, freqs: [246.94], len: 0.20, amp: 0.09 },          // Act 3b: Thin PM book block
    { t: 23.05, freqs: [587.33, 880.0], len: 0.25, amp: 0.12 },   // Act 4a: SOL-PERP 8/8 PASS armed
    { t: 26.55, freqs: [1046.5, 1318.51, 1567.98], len: 0.38, amp: 0.14 }, // Act 4b: Solana V0 Devnet Tx confirmed
    { t: 33.55, freqs: [185.0], len: 0.22, amp: 0.10 },           // Act 5: Whale counter-sweep blocked
    { t: 40.55, freqs: [659.25, 987.77], len: 0.25, amp: 0.12 },  // Act 6a: Prediction Market HUD armed
    { t: 43.22, freqs: [880.0], len: 0.08, amp: 0.11 },           // Act 6b: G2 Temple Tap mode toggle
    { t: 45.05, freqs: [1174.66, 1479.98, 1760.0], len: 0.40, amp: 0.14 }, // Act 6c: G2 2xTap Devnet execution
  ];

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const envGlobal = Math.min(1, t / 1.4, (durationSec - t) / 1.6);
    // Warm dark institutional drone (98 Hz G2 + subtle fifth)
    let sample =
      (Math.sin(2 * Math.PI * 98 * t) * 0.012 +
        Math.sin(2 * Math.PI * 146.83 * t) * 0.006) *
      Math.max(0, envGlobal);

    for (const cue of cues) {
      if (t >= cue.t && t <= cue.t + cue.len) {
        const dt = t - cue.t;
        const env = Math.exp((-dt * 7.2) / cue.len) * Math.min(1, dt / 0.006);
        for (const f of cue.freqs) {
          sample += (Math.sin(2 * Math.PI * f * dt) * cue.amp * env) / cue.freqs.length;
        }
      }
    }

    const clamped = Math.max(-0.95, Math.min(0.95, sample));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  fs.writeFileSync(wavPath, buffer);
}

async function main() {
  fs.mkdirSync(DEMO_DIR, { recursive: true });
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  console.log('[DEMO-RECORDER] Building production bundle...');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });

  const port = 4291;
  const server = spawn(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      'preview',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
    ],
    { cwd: ROOT, stdio: 'pipe' }
  );
  await new Promise((r) => setTimeout(r, 1600));

  const executablePath = findChromiumExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  const cleanupSignal = async () => {
    try {
      await browser.close();
    } catch {
      // ignore
    }
    try {
      server.kill('SIGTERM');
    } catch {
      // ignore
    }
    process.exit(143);
  };
  process.once('SIGTERM', cleanupSignal);
  process.once('SIGINT', cleanupSignal);

  const fps = 30;
  const durationSec = 50;
  const totalFrames = fps * durationSec;

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    console.log(
      '[DEMO-RECORDER] Opening LiveEdge Solana Terminal at 1920x1080 (?demo=1&manualStep=1)...'
    );
    await page.goto(`http://127.0.0.1:${port}/?demo=1&manualStep=1`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('#risk-verdict-banner');

    for (let frame = 0; frame < totalFrames; frame++) {
      const tMs = (frame * 1000) / fps;
      await page.evaluate(async (ms) => {
        if (typeof window.__stepSolanaDemoAtTimeMs === 'function') {
          await window.__stepSolanaDemoAtTimeMs(ms);
        }
      }, tMs);
      const framePath = path.join(
        FRAMES_DIR,
        `frame_${String(frame).padStart(5, '0')}.jpg`
      );
      await page.screenshot({ path: framePath, type: 'jpeg', quality: 94 });
      if (frame === 840) {
        fs.copyFileSync(framePath, path.join(DEMO_DIR, 'preview-terminal.jpg'));
      }
      if (frame % 180 === 0 || frame === totalFrames - 1) {
        const st = await page.evaluate(() => window.__solanaDemoState);
        console.log(
          `[DEMO-RECORDER] Frame ${frame}/${totalFrames} (${(tMs / 1000).toFixed(1)}s) | Act=${st?.actIndex ?? 0} | Scenario=${st?.scenarioId ?? ''} | Receipts=${st?.receiptCount ?? 0}`
        );
      }
    }

    await context.close();
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  const wavPath = path.join(DEMO_DIR, 'solana_soundtrack.wav');
  synthesizeCinematicSoundtrackWav(wavPath, durationSec);

  console.log('[DEMO-RECORDER] Encoding 1920x1080 30fps H.264 MP4 via FFmpeg...');
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      path.join(FRAMES_DIR, 'frame_%05d.jpg'),
      '-i',
      wavPath,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-shortest',
      '-movflags',
      '+faststart',
      OUTPUT_MP4,
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );

  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.rmSync(wavPath, { force: true });

  const stat = fs.statSync(OUTPUT_MP4);
  console.log(
    `\n✅ HD Demo Video Ready: ${OUTPUT_MP4} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)\n`
  );
}

main().catch((err) => {
  console.error('Demo recording failed:', err);
  process.exit(1);
});
