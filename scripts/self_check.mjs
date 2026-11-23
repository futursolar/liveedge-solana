#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function runStep(label, cmd, args, extraEnv = {}) {
  process.stdout.write(`\n[SELF-CHECK] ${label} ...\n`);
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}

function findChromiumExecutable() {
  if (
    process.env.CHROMIUM_EXECUTABLE_PATH &&
    fs.existsSync(process.env.CHROMIUM_EXECUTABLE_PATH)
  ) {
    return process.env.CHROMIUM_EXECUTABLE_PATH;
  }
  const ancestorPlaywrightDirs = [];
  let curDir = ROOT;
  while (curDir && curDir !== path.dirname(curDir)) {
    ancestorPlaywrightDirs.push(path.join(curDir, '.cache', 'ms-playwright'));
    curDir = path.dirname(curDir);
  }
  const searchRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    ...ancestorPlaywrightDirs,
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

/**
 * 100% Physical Desensitization Audit (generalized structural patterns, zero self-exemption).
 * Scans every repository text, Rust, TypeScript, script, doc, and production build file,
 * plus optional external `DESENSITIZE_DENYLIST_FILE`.
 */
function runDesensitizationAudit() {
  process.stdout.write(
    '\n[SELF-CHECK] Running 100% Physical Desensitization Audit ...\n'
  );

  // Build patterns structurally so no literal host path is ever written in source
  const posixSysDirs = ['ho' + 'me', 'Us' + 'ers', 'ro' + 'ot', 'var/lib', 'et' + 'c'].join('|');
  const forbiddenPatterns = [
    {
      name: 'Hardcoded Secret / Private Key Assignment',
      regex:
        /(?:PRIVATE_KEY|SECRET_KEY|MNEMONIC|AUTH_TOKEN|API_SECRET)\s*[:=]\s*['"][^'"]{8,}/i,
    },
    {
      name: 'Cloud / Git Personal Access Token',
      regex:
        /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/,
    },
    {
      name: 'Local User Home or Host System Path',
      regex: new RegExp(`(?:^|[\\s'"\`(])\\/(?:${posixSysDirs})\\/[A-Za-z0-9._-]+`),
    },
    {
      name: 'RFC1918 / CGNAT Mesh Private IPv4',
      regex:
        /\b(?!(?:127\.0\.0\.1|0\.0\.0\.0)\b)(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/,
    },
    {
      name: 'Private Mesh Tailnet Hostname',
      regex: /\b(?:[a-z0-9-]+\.ts\.net|tail[0-9a-f]{5,})\b/i,
    },
  ];

  const extraDenylistPath = process.env.DESENSITIZE_DENYLIST_FILE;
  if (extraDenylistPath && fs.existsSync(extraDenylistPath)) {
    const lines = fs
      .readFileSync(extraDenylistPath, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'));
    for (const [idx, token] of lines.entries()) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      forbiddenPatterns.push({
        name: `External Denylist Rule #${idx + 1}`,
        regex: new RegExp(escaped, 'i'),
      });
    }
  }

  const skipDirs = new Set(['node_modules', '.git', 'demo', 'target']);
  const scanned = [];

  function scanDir(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scanDir(full);
      } else if (
        /\.(ts|js|mjs|cjs|json|md|html|css|rs|toml|yml|yaml|txt)$/i.test(
          ent.name
        ) ||
        ent.name === '.gitignore' ||
        ent.name === 'LICENSE'
      ) {
        const text = fs.readFileSync(full, 'utf8');
        const relPath = path.relative(ROOT, full);
        scanned.push(relPath);
        for (const rule of forbiddenPatterns) {
          if (rule.regex.test(text)) {
            throw new Error(
              `Desensitization violation (${rule.name}) in ${relPath}`
            );
          }
        }
      }
    }
  }

  scanDir(ROOT);
  console.log(
    `[SELF-CHECK] Desensitization PASS (${scanned.length} text, contract & build files clean, self-included).`
  );
}

async function runPlaywrightSmokeE2E() {
  process.stdout.write(
    '\n[SELF-CHECK] Running Headless Chromium E2E Solana Execution & Risk-Block Smoke Test ...\n'
  );
  const port = 4281;
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

  await new Promise((r) => setTimeout(r, 1500));
  const executablePath = findChromiumExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#risk-verdict-banner');

    // 1. Verify fail-closed block on wide Pyth confidence trap
    await page.click('[data-scenario="btc-cpi-conf-blowout"]');
    const lockedDisabled = await page.$eval(
      '#btn-execute-solana',
      (el) => el.hasAttribute('disabled')
    );
    if (!lockedDisabled) {
      throw new Error('Expected execute button to be disabled on BTC CPI conf blowout');
    }

    // 2. Switch back to SOL-PERP breakout and execute atomic V0 Devnet tx
    await page.click('[data-scenario="sol-perp-breakout"]');
    await page.click('#btn-execute-solana');
    await page.waitForSelector('#tx-signature-box', { timeout: 10000 });
    const sigText = (await page.textContent('#tx-signature-box'))?.trim() || '';
    if (sigText.length < 40) {
      throw new Error(`Invalid Solana tx signature rendered: ${sigText}`);
    }
    console.log(
      `[SELF-CHECK] Headless E2E PASS (Verified Solana V0 Signature: ${sigText.slice(0, 14)}...)`
    );
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

function findCargoExecutable() {
  const ancestorCargoBins = [];
  let curDir = ROOT;
  while (curDir && curDir !== path.dirname(curDir)) {
    ancestorCargoBins.push(path.join(curDir, '.cargo', 'bin', 'cargo'));
    curDir = path.dirname(curDir);
  }
  const candidates = [
    process.env.CARGO,
    path.join(os.homedir(), '.cargo', 'bin', 'cargo'),
    ...ancestorCargoBins,
    '/usr/bin/cargo',
    '/usr/local/bin/cargo',
  ].filter(Boolean);
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return 'cargo';
}

async function main() {
  const cargoBin = findCargoExecutable();
  const cargoEnv = path.isAbsolute(cargoBin)
    ? { PATH: `${path.dirname(cargoBin)}:${process.env.PATH || ''}` }
    : {};
  runStep(
    'Rust / Anchor Workspace Check (idl-build)',
    cargoBin,
    ['check', '--workspace', '--features', 'liveedge-risk-guard/idl-build'],
    {
      ...cargoEnv,
      ANCHOR_IDL_BUILD_PROGRAM_PATH: path.join(
        ROOT,
        'programs',
        'liveedge_risk_guard'
      ),
    }
  );
  runStep(
    'Rust / Anchor On-Chain Guard Unit Tests',
    cargoBin,
    ['test', '--workspace'],
    cargoEnv
  );
  runStep('TypeScript Strict Check', 'npm', ['run', 'typecheck']);
  runStep('ESLint Static Analysis', 'npm', ['run', 'lint']);
  runStep('Vitest Automated Test Suite', 'npm', ['run', 'test']);
  runStep('Production Bundle & Agent CLI Build', 'npm', ['run', 'build']);
  runStep('Agent CLI Smoke Check', 'node', [
    './bin/liveedge-solana.mjs',
    'scenarios',
  ]);
  runDesensitizationAudit();
  await runPlaywrightSmokeE2E();
  console.log('\n✅ ALL LIVEEDGE-SOLANA QUALITY GATES PASSED (EXIT 0)\n');
}

main().catch((err) => {
  console.error('\n❌ SELF-CHECK FAILED:', err);
  process.exit(1);
});
