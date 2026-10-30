import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { themeStylesheet } from '@hatti/tokens';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';
import { headersFile, securityHeaders } from './src/edge/headers.ts';
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

/**
 * The edge's headers (ADR-513): written beside the build as `_headers`, and sent by `vite preview`
 * so the built admin is tried under its content security policy. `vite dev` sends none, React's
 * refresh running inline there.
 */
function edgeHeaders(): Plugin {
  return {
    name: 'hatti-edge-headers',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: headersFile() });
    },
    configurePreviewServer(server) {
      const headers = Object.entries(securityHeaders());
      server.middlewares.use((_request, response, next) => {
        for (const [name, value] of headers) response.setHeader(name, value);
        next();
      });
    },
  };
}

// In development the admin is served on its own port and sends the API's paths on to the core
// (`pnpm dev:api`), so the browser sees one origin, as it does behind the edge in production.
const api = process.env.HATTI_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [hattiTokens(), react(), tailwindcss(), serviceWorker(), edgeHeaders()],
  server: {
    port: 5173,
    proxy: {
      '/admin/api': api,
      '/admin/errors': api,
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
    // The theme editor frames the storefront (ADR-325): its tests say what the page there says,
    // and no page is fetched for it.
    environmentOptions: {
      happyDOM: { settings: { navigation: { disableChildFrameNavigation: true } } },
    },
    setupFiles: ['./src/accessibility-check.ts', './src/test-setup.ts'],
    // A test waits up to 5 seconds for each thing it looks for (test-setup.ts); one that walks
    // through several pages needs longer than vitest's own 5 seconds on a busy machine.
    testTimeout: 20_000,
    // Each test file's first screen is read by axe in a hook once its test is done
    // (accessibility-check.ts), which takes as long as a test may on a busy machine.
    hookTimeout: 20_000,
  },
});
