// Builds the app for one channel, then packages it: node tools/dist.mjs <alpha|release>
// The channel is a build-time define (electron.vite.config.ts reads VSS_CHANNEL); the bundle is checked afterwards
// with tools/verify-channel.mjs so a stale `out/` from another channel can never be packaged by mistake.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const channel = process.argv[2];
if (channel !== 'alpha' && channel !== 'release') {
  console.error('usage: node tools/dist.mjs <alpha|release>');
  process.exit(2);
}
const env = { ...process.env, VSS_CHANNEL: channel };

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

rmSync('out', { recursive: true, force: true });
run('electron-vite', ['build']);
run('node', ['tools/verify-channel.mjs', 'out/main/index.js', channel]);
run('electron-builder', ['--config', 'electron-builder.yml', '--win', 'nsis', 'portable', '--publish', 'never']);
