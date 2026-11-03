import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = { '@shared': resolve('src/shared') };

export default defineConfig({
  main: {
    resolve: { alias },
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
