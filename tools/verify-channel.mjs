// Asserts which build channel a bundled main script was compiled for.
// Usage: node tools/verify-channel.mjs [out/main/index.js] [alpha|release|dev]
// The build define replaces `__VSS_CHANNEL__` with a string literal; the bundle must contain the expected literal as
// the channel constant and must not contain the other channels' literals in that position.
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'out/main/index.js';
const want = process.argv[3] ?? 'alpha';
if (!['alpha', 'release', 'dev'].includes(want)) {
  console.error(`unknown channel: ${want}`);
  process.exit(2);
}
const text = readFileSync(file, 'utf8');
if (text.includes('__VSS_CHANNEL__')) {
  if (want === 'dev') {
    console.log(`ok   ${file}: channel define not replaced (dev build)`);
    process.exit(0);
  }
  console.error(`FAIL ${file}: __VSS_CHANNEL__ was not replaced (not built with VSS_CHANNEL=${want})`);
  process.exit(1);
}
// Rollup output (main is not minified) reads: var CHANNEL = parseChannel$1("alpha");
const m = /\bCHANNEL = [\w$]+\(\s*"(dev|alpha|release)"\s*\)/.exec(text);
if (!m) {
  if (want === 'dev') {
    console.log(`ok   ${file}: no channel literal (dev build)`);
    process.exit(0);
  }
  console.error(`FAIL ${file}: channel constant not found`);
  process.exit(1);
}
const got = m[1];
console.log(`${got === want ? 'ok  ' : 'FAIL'} ${file}: channel ${got} (want ${want})`);
process.exit(got === want ? 0 : 1);
