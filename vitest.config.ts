import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['tests/{unit,property,golden,security}/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
