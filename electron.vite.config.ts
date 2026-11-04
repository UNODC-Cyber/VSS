import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

import { channelVersionProblem, parseChannel } from './src/main/app/channel';

const alias = { '@shared': resolve('src/shared') };

// Build channel (docs/PLAN-ALPHA.md section 12): VSS_CHANNEL=alpha|release, unset = dev. A prerelease version is only
// ever built as alpha (and an alpha only from a prerelease version), so a wrong tag/script pairing fails the build.
const channel = parseChannel(process.env.VSS_CHANNEL);
const pkgVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const problem = channelVersionProblem(channel, pkgVersion);
if (problem) throw new Error(`VSS channel/version mismatch: ${problem}`);

export default defineConfig({
  main: {
    resolve: { alias },
    define: { __VSS_CHANNEL__: JSON.stringify(channel) },
    build: {
      outDir: 'out/main',
      lib: { entry: resolve('src/main/index.ts'), formats: ['es'] },
      rollupOptions: { external: ['better-sqlite3-multiple-ciphers'] },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      // Sandboxed preload must be CommonJS.
      lib: { entry: resolve('src/preload/index.ts'), formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: resolve('src/renderer/index.html') },
      modulePreload: { polyfill: false },
      assetsInlineLimit: 0,
      cssCodeSplit: false,
    },
  },
});
