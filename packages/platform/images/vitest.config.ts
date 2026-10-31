import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Clean copies of photos thousands of pixels a side are made and measured: on a machine
    // running every package's tests at once that takes longer than vitest's own 5 seconds.
    testTimeout: 30_000,
  },
});
