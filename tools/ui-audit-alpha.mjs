// UI audit on the alpha channel (UI review R3O-H1): builds the app the way `npm run dist:alpha` does (VSS_CHANNEL=alpha
// build define), checks the bundle really is an alpha build, then runs the UI audit harness with
// VSS_UI_AUDIT_CHANNEL=alpha so it also captures the alpha banner, Help menu, About dialog, Send feedback and the
// Settings Updates note. Nothing is packaged. Default viewports: 1280x720 and 1366x768 (VSS_UI_AUDIT_ONLY overrides).
// Run: npm run ui-audit:alpha. Rebuild with `npm run build` afterwards to get a dev bundle back.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const env = {
  ...process.env,
  VSS_CHANNEL: 'alpha',
  VSS_UI_AUDIT_CHANNEL: 'alpha',
  VSS_UI_AUDIT_ONLY: process.env.VSS_UI_AUDIT_ONLY ?? '1280x720,1366x768',
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

rmSync('out', { recursive: true, force: true });
run('electron-vite', ['build']);
run('node', ['tools/verify-channel.mjs', 'out/main/index.js', 'alpha']);
run('vitest', ['run', '--config', 'vitest.ui.config.ts']);
