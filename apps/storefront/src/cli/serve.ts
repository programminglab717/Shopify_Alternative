import { StorefrontApiClient } from '@hatti/storefront-api';
import { MemoryStore } from '@hatti/storefront-data';
import { Redis } from 'ioredis';
import { sampleStore } from '../fixtures.js';
import { PageRenderer } from '../render.js';
import { createStorefrontServer } from '../server.js';
import { shutdownTelemetry } from '@hatti/telemetry';
import { allPlatformThemes } from '@hatti/themes';

// Serves storefronts in Hatti Base, to look at pages as a phone would: pnpm dev:storefront. The
// platform's domain, from STOREFRONT_URL (http://localhost:4100 unless set), shows the sample
// shop; each shop the core has published answers at its handle's subdomain, such as
// http://zari.localhost:4100/, from Valkey at REDIS_URL, in its own theme. Urdu pages are under
// /ur/. Images under /images/ are placeholders drawn to size. Carts are the core's, at
// CORE_API_URL (http://localhost:4000 unless set), reached with STOREFRONT_SERVICE_KEY. The theme
// editor may frame previews from STOREFRONT_EDITOR_ORIGINS, a comma-separated list of origins.
//
// With NODE_ENV=production, as its container runs it (ADR-724), it serves published shops alone:
// no sample shop or placeholder images; STOREFRONT_URL, REDIS_URL, CORE_API_URL and
// STOREFRONT_SERVICE_KEY must be set; TRUST_PROXY=true takes shoppers' addresses from the edge's
// X-Forwarded-For; and SIGTERM lets the requests in flight finish before it exits.

const production = process.env.NODE_ENV === 'production';
if (production) {
  const missing = ['STOREFRONT_URL', 'REDIS_URL', 'CORE_API_URL', 'STOREFRONT_SERVICE_KEY'].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) throw new Error(`Set ${missing.join(', ')} to serve in production`);
}
// Hatti's themes (ADR-730), each shop's theme over the one it is built on.
const platformThemes = await allPlatformThemes();
const theme = platformThemes.get('hatti-base')!;
const site = new URL(process.env.STOREFRONT_URL ?? 'http://localhost:4100');
const renderer = new PageRenderer(theme, {
  platformUrl: site.origin,
  onError: (render, error) => console.error(`${render.id} not shown:`, (error as Error).message),
});
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const key = process.env.STOREFRONT_SERVICE_KEY;
const core =
  key &&
  new StorefrontApiClient({ baseUrl: process.env.CORE_API_URL ?? 'http://localhost:4000', key });
if (!core) console.warn('No STOREFRONT_SERVICE_KEY: carts cannot change (see .env.example).');
const editorOrigins = (process.env.STOREFRONT_EDITOR_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
for (const origin of editorOrigins) {
  if (new URL(origin).origin !== origin) {
    throw new Error(
      `STOREFRONT_EDITOR_ORIGINS: ${origin} is not an origin, such as https://admin.hatti.pk`,
    );
  }
}
const app = createStorefrontServer({
  theme,
  platformThemes,
  renderer,
  domain: site.hostname,
  redis,
  core: core || undefined,
  secureCookies: site.protocol === 'https:',
  trustProxy: process.env.TRUST_PROXY === 'true',
  sample: production ? undefined : new MemoryStore(sampleStore()),
  placeholders: !production,
  onThemeFileRejected: (shopId, error) =>
    console.error(`Shop ${shopId}'s theme file left out:`, error.message),
  editorOrigins,
});

const port = Number(process.env.STOREFRONT_PORT ?? (site.port || 4100));
await app.listen({ port, host: '0.0.0.0' });

// Kubernetes sends SIGTERM and waits for its grace period; a second signal exits at once.
let closing = false;
const stop = () => {
  if (closing) process.exit(1);
  closing = true;
  app
    .close()
    .then(() => redis.quit())
    // Flush the last spans and metrics, or they are lost with the process.
    .then(() => shutdownTelemetry())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Shutdown failed:', (error as Error).message);
      process.exit(1);
    });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

if (production) {
  console.log(`Serving published shops on port ${port}, at their handles under ${site.hostname}`);
} else {
  const at = (handle?: string) =>
    `${site.protocol}//${handle ? `${handle}.` : ''}${site.hostname}:${port}/`;
  console.log(`The sample shop at ${at()} (Urdu: /ur/), and published shops at ${at('<handle>')}`);
}
