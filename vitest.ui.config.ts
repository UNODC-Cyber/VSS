import { defineConfig } from 'vitest/config';

/**
 * UI audit harness (docs/ui-audit/RUBRIC.md). Not part of `npm test` or CI: it drives the built app (`npm run build`
 * first) and writes screenshots outside the repo. Run with `npm run ui-audit`.
 */
export default defineConfig({
  test: {
    include: ['tests/ui-audit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 1_800_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
