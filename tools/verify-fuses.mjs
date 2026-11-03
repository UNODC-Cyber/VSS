// Reads the fuse wire of a built VSS executable and fails unless the hardened configuration is present.
// Usage: node tools/verify-fuses.mjs <path-to-vss.exe>  (default: dist/win-unpacked/Vetting Support System.exe)
import { getCurrentFuseWire, FuseState, FuseV1Options } from '@electron/fuses';
import { existsSync } from 'node:fs';

const exe = process.argv[2] ?? 'dist/win-unpacked/Vetting Support System.exe';
if (!existsSync(exe)) {
  console.error(`Not found: ${exe}`);
  process.exit(2);
}
const wire = await getCurrentFuseWire(exe);
const expected = {
  [FuseV1Options.RunAsNode]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
};
let bad = 0;
for (const [opt, want] of Object.entries(expected)) {
  const got = wire[opt];
  const name = FuseV1Options[opt];
  const okay = got === want;
  if (!okay) bad++;
  console.log(`${okay ? 'ok  ' : 'FAIL'} ${name}: ${FuseState[got]} (want ${FuseState[want]})`);
}
process.exit(bad === 0 ? 0 : 1);
