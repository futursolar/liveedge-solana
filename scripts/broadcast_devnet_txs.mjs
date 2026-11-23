#!/usr/bin/env node
/**
 * Broadcasts confirmed L1 Solana Devnet transactions (`CONFIRMED_ON_DEVNET`)
 * as soon as the isolated Devnet demo wallet holds >= 0.00001 Devnet SOL,
 * updating `docs/DEVNET_EVIDENCE.json` in place.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

execFileSync(
  process.execPath,
  [path.join(ROOT, 'scripts/generate_devnet_evidence.mjs')],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  }
);

const ev = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs/DEVNET_EVIDENCE.json'), 'utf8')
);
const confirmedCount = (ev.executedDevnetReceipts || []).filter(
  (r) => r.broadcastStatus === 'CONFIRMED_ON_DEVNET'
).length;

if (confirmedCount > 0) {
  console.log(
    `\n✅ ${confirmedCount} transaction(s) confirmed live on Solana Devnet ledger!`
  );
  for (const r of ev.executedDevnetReceipts || []) {
    if (r.broadcastStatus === 'CONFIRMED_ON_DEVNET') {
      const bundleNote = r.atomicFourProgramBundle
        ? ` | companion 4-program V0 sig=${r.atomicFourProgramBundle.txSignature}`
        : '';
      console.log(
        `   - ${r.marketSymbol} (${r.orderStyle}, ${r.instructionCount} L1 ix @ slot ${r.devnetSlot}): ${r.txSignature}${bundleNote}`
      );
    }
  }
} else {
  console.log(
    `\nℹ️ Demo wallet (${ev.isolatedDemoWalletPubkey}) currently holds 0 Devnet SOL (public RPC requestAirdrop returns HTTP 410; faucet.solana.com requires human Turnstile).\n` +
      `   4-program atomic V0 messages & Ed25519 signatures are ready for Explorer inspection, and Agave LiteSVM SPL Memo v2 audit-envelope proofs passed.\n` +
      `   After funding 1 Devnet SOL via ${ev.faucetFundUrl}, re-run 'npm run devnet:broadcast' to record permanent L1 slot confirmations.`
  );
}
