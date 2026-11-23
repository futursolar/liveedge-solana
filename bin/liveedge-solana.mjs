#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundled = path.resolve(__dirname, '../dist-cli/agentCli.mjs');

if (!fs.existsSync(bundled)) {
  await import(pathToFileURL(path.resolve(__dirname, '../scripts/build_cli.mjs')).href);
}

const mod = await import(pathToFileURL(bundled).href);
const code = await mod.runAgentCli(process.argv.slice(2));
process.exitCode = code;
