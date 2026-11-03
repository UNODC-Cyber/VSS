#!/usr/bin/env node
// Launcher for the TypeScript release tools (loads them through Vite's module runner, no extra dependencies).
//   node tools/release/run.mjs gen-keys --out <file outside the repo>
//   node tools/release/run.mjs sign-manifest --dir <assets> --version <x.y.z> --seeds <file|->
//   node tools/release/run.mjs verify-release --dir <assets> [--expect-version x.y.z]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runnerImport } from 'vite';

const TOOLS = new Set(['gen-keys', 'sign-manifest', 'verify-release']);
const [tool, ...args] = process.argv.slice(2);
if (!tool || !TOOLS.has(tool)) {
  process.stderr.write(`Usage: node tools/release/run.mjs <${[...TOOLS].join('|')}> [options]\n`);
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
try {
  const { module } = await runnerImport(join(here, `${tool}.ts`), {
    configFile: false,
    logLevel: 'silent',
    root: join(here, '..', '..'),
  });
  const code = await module.main(args);
  process.exit(typeof code === 'number' ? code : 0);
} catch (e) {
  process.stderr.write(`${tool}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
