import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Some tests make hundreds of requests, or check passwords with a slow hash, against Valkey:
    // under the rest of the suite's load they take longer than the default five seconds.
    testTimeout: 30_000,
  },
});
