import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The live tests skip themselves unless LIVE=1; they read mainnet and simulate, and never send.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
