import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: [
      // graphql ships CommonJS ("main") and ESM ("module") builds. Node, and so NestJS and
      // Mercurius, load the CommonJS one; Vite would give our sources the ESM one, and two copies
      // of graphql cannot share a schema. Pin the one Node uses.
      { find: /^graphql$/, replacement: require.resolve('graphql') },
    ],
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
