// Documented replacement for the electron postinstall step (.npmrc sets ignore-scripts=true, so nothing runs on its own).
// Downloads the Electron binary if missing. Run once after `npm ci`: `npm run setup`. Idempotent.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electronDir = dirname(require.resolve('electron/package.json'));
const exe = join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

if (existsSync(exe) && existsSync(join(electronDir, 'path.txt'))) {
  process.exit(0);
}
console.log('Downloading the Electron binary (the only install script VSS allows)...');
const r = spawnSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
