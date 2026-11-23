#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

await build({
  entryPoints: [path.join(ROOT, 'src/cli/agentCli.ts')],
  outfile: path.join(ROOT, 'dist-cli/agentCli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
});

console.log('[BUILD-CLI] Bundled dist-cli/agentCli.mjs');
