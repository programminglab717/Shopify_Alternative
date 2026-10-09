import { themeStylesheet } from '@hatti/tokens';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

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

// In development the admin is served on its own port and sends the API's paths on to the core
// (`pnpm dev:api`), so the browser sees one origin, as it does behind the edge in production.
const api = process.env.HATTI_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [hattiTokens(), react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/admin/api': api,
      '/auth': api,
    },
  },
  build: { sourcemap: true, target: 'es2022' },
  test: { environment: 'happy-dom', setupFiles: ['./src/test-setup.ts'] },
});
