import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file creates its own database; keep the default parallelism but allow for slow CI.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
