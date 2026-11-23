#!/usr/bin/env node
/**
 * Generates verifiable Solana Devnet execution evidence (`docs/DEVNET_EVIDENCE.json`)
 * using either an external `LIVEEDGE_DEVNET_KEYPAIR_PATH` (zero private keys inside repo)
 * or a fresh ephemeral Ed25519 keypair, executing real V0 transactions against
 * `https://api.devnet.solana.com` (`sendRawTransaction` when funded, or live Solana
 * Devnet BPF VM `simulateTransaction` + official Solana Explorer Inspector verification URLs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Connection, Keypair } from '@solana/web3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Ensure CLI bundle is fresh so we can import the compiled TypeScript engine cleanly
await import(pathToFileURL(path.join(ROOT, 'scripts/build_cli.mjs')).href);

import { build } from 'esbuild';
const engineBundlePath = path.join(ROOT, 'dist-cli/evidenceRunner.mjs');
await build({
  entryPoints: [path.join(ROOT, 'src/solana/devnetExecutor.ts'), path.join(ROOT, 'src/oracle/pythHermesGuard.ts'), path.join(ROOT, 'src/venues/marketDataClient.ts'), path.join(ROOT, 'src/engine/solanaRiskGate.ts')],
  outdir: path.join(ROOT, 'dist-cli/modules'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
});

const { fetchLivePythFeeds } = await import(
  pathToFileURL(path.join(ROOT, 'dist-cli/modules/oracle/pythHermesGuard.js')).href
);
const { buildScenarioBundle } = await import(
  pathToFileURL(path.join(ROOT, 'dist-cli/modules/venues/marketDataClient.js')).href
);
const { evaluateSolanaRiskGate } = await import(
  pathToFileURL(path.join(ROOT, 'dist-cli/modules/engine/solanaRiskGate.js')).href
);
const { executeRiskGatedSolanaOrder, DEFAULT_SOLANA_DEVNET_RPC } = await import(
  pathToFileURL(path.join(ROOT, 'dist-cli/modules/solana/devnetExecutor.js')).href
);

function loadDemoKeypair() {
  const extPath = process.env.LIVEEDGE_DEVNET_KEYPAIR_PATH;
  if (extPath && fs.existsSync(extPath)) {
    const parsed = JSON.parse(fs.readFileSync(extPath, 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : parsed.secretKeyArray;
    if (arr && arr.length === 64) {
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
  }
  return Keypair.generate();
}

const rpcUrl = process.env.SOLANA_DEVNET_RPC_URL || DEFAULT_SOLANA_DEVNET_RPC;
const conn = new Connection(rpcUrl, 'confirmed');
const keypair = loadDemoKeypair();
const balanceLamports = await conn.getBalance(keypair.publicKey).catch(() => 0);
const devnetVersion = await conn.getVersion().catch(() => ({ 'solana-core': 'unknown' }));
const devnetSlot = await conn.getSlot('confirmed').catch(() => 0);
const liveFeeds = await fetchLivePythFeeds({ timeoutMs: 5000 });

const executedReceipts = [];
for (const [scenarioId, style] of [
  ['sol-perp-breakout', 'IOC_LIMIT'],
  ['pm-clutch-repricing', 'POST_ONLY'],
]) {
  const bundle = buildScenarioBundle(scenarioId, liveFeeds, Date.now(), devnetSlot);
  const decision = evaluateSolanaRiskGate(
    bundle.impulse,
    bundle.pythFeed,
    bundle.orderbook,
    10.0
  );
  const receipt = await executeRiskGatedSolanaOrder({
    impulse: bundle.impulse,
    pythFeed: bundle.pythFeed,
    book: bundle.orderbook,
    decision,
    orderStyle: style,
    keypair,
    signerMode: balanceLamports >= 10_000 ? 'DEVNET_KEYPAIR_LIVE' : 'DEVNET_BPF_SIMULATION',
    devnetRpcUrl: rpcUrl,
  });
  executedReceipts.push(receipt);
}

const blockedProofs = ['btc-cpi-conf-blowout', 'eth-stale-oracle-trap', 'pm-thin-depth-trap', 'sol-adverse-whale-trap'].map((id) => {
  const bundle = buildScenarioBundle(id, liveFeeds, Date.now(), devnetSlot);
  const decision = evaluateSolanaRiskGate(bundle.impulse, bundle.pythFeed, bundle.orderbook, 10.0);
  return {
    scenarioId: id,
    market: bundle.orderbook.symbol,
    passed: decision.passed,
    rejectionCode: decision.rejectionCode,
    reason: decision.reason,
  };
});

const evidenceDoc = {
  generatedAtIso: new Date().toISOString(),
  cluster: 'devnet',
  rpcEndpoint: rpcUrl,
  solanaCoreVersion: devnetVersion['solana-core'],
  observedDevnetSlot: devnetSlot,
  isolatedDemoWalletPubkey: keypair.publicKey.toBase58(),
  demoWalletBalanceSol: balanceLamports / 1e9,
  faucetFundUrl: `https://faucet.solana.com/?walletAddress=${keypair.publicKey.toBase58()}&amount=1&cluster=devnet`,
  livePythSnapshots: liveFeeds,
  executedDevnetReceipts: executedReceipts,
  failClosedInterceptions: blockedProofs,
};

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
const outPath = path.join(ROOT, 'docs/DEVNET_EVIDENCE.json');
fs.writeFileSync(outPath, JSON.stringify(evidenceDoc, null, 2) + '\n', 'utf8');
console.log(`[DEVNET-EVIDENCE] Wrote ${outPath}`);
console.log(`  Demo Pubkey: ${evidenceDoc.isolatedDemoWalletPubkey} (${evidenceDoc.demoWalletBalanceSol} Devnet SOL)`);
for (const r of executedReceipts) {
  console.log(`  [${r.broadcastStatus}] ${r.marketSymbol} (${r.orderStyle}) -> sig=${r.txSignature}`);
}
