import { themeStylesheet } from '@hatti/tokens';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';
import { headersFile, securityHeaders } from './src/headers.ts';

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

/** The edge's headers, written beside the build as `_headers` and sent by `vite preview`. */
function edgeHeaders(): Plugin {
  return {
    name: 'hatti-console-headers',
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

// In development the console is served on its own port and sends its server's paths on to the
// console's server (`pnpm --filter @hatti/core console`), as the console's address does behind
// the edge in production.
const consoleServer = process.env.HATTI_CONSOLE_URL ?? 'http://localhost:4100';

export default defineConfig({
  plugins: [hattiTokens(), react(), tailwindcss(), edgeHeaders()],
  server: {
    port: 5174,
    proxy: { '/console/api': consoleServer },
  },
  build: { sourcemap: true, target: 'es2022' },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/accessibility-check.ts', './src/test-setup.ts'],
    testTimeout: 20_000,
    // Each test file's first screen is read by axe in a hook once its test is done
    // (accessibility-check.ts), which takes as long as a test may on a busy machine.
    hookTimeout: 20_000,
  },
});
