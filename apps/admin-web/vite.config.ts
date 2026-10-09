import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { themeStylesheet } from '@hatti/tokens';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';
import { precacheOf } from './src/offline/rules.ts';

const TOKENS = 'virtual:hatti-tokens.css';

/** Hatti UI's tokens (packages/ui/tokens) as CSS variables, light and dark, at `virtual:hatti-tokens.css`. */
function hattiTokens(): Plugin {
  const resolved = `\0${TOKENS}`;
  return {
    name: 'hatti-tokens',
    resolveId: (id) => (id === TOKENS ? resolved : undefined),
    load: (id) => (id === resolved ? themeStylesheet() : undefined),
  };
}

/**
 * The service worker (ADR-295): src/offline/service-worker.ts, built beside the page as /sw.js and
 * told the build's version and the files it keeps. The version is the build's file names, which
 * carry their content's hash, and the public folder's files with their content: a build that
 * changes nothing the worker keeps installs no new worker.
 */
function serviceWorker(): Plugin {
  let publicDir = '';
  return {
    name: 'hatti-service-worker',
    apply: 'build',
    configResolved: (config) => {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      const worker = bundle['sw.js'];
      if (worker?.type !== 'chunk') throw new Error('The service worker was not built to sw.js');
      const publicFiles = readdirSync(publicDir).sort();
      const hash = createHash('sha256');
      for (const name of Object.keys(bundle).sort()) hash.update(`${name}\n`);
      for (const name of publicFiles) hash.update(name).update(readFileSync(join(publicDir, name)));
      const precache = precacheOf([...Object.keys(bundle), ...publicFiles]);
      const version = hash.digest('hex').slice(0, 16);
      worker.code = `self.__hatti=${JSON.stringify({ version, precache })};${worker.code}`;
    },
  };
}

// In development the admin is served on its own port and sends the API's paths on to the core
// (`pnpm dev:api`), so the browser sees one origin, as it does behind the edge in production.
const api = process.env.HATTI_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [hattiTokens(), react(), tailwindcss(), serviceWorker()],
  server: {
    port: 5173,
    proxy: {
      '/admin/api': api,
      '/auth': api,
    },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      input: { index: 'index.html', sw: 'src/offline/service-worker.ts' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    // A test waits up to 5 seconds for each thing it looks for (test-setup.ts); one that walks
    // through several pages needs longer than vitest's own 5 seconds on a busy machine.
    testTimeout: 20_000,
  },
});
