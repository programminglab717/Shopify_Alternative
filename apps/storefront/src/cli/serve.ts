import { fileURLToPath } from 'node:url';
import { MemoryStore } from '@hatti/storefront-data';
import { Redis } from 'ioredis';
import { sampleStore } from '../fixtures.js';
import { PageRenderer } from '../render.js';
import { createStorefrontServer } from '../server.js';
import { loadTheme, readThemeDir } from '../theme.js';

// Serves storefronts in Hatti Base, to look at pages as a phone would: pnpm dev:storefront. The
// platform's domain, from STOREFRONT_URL (http://localhost:4100 unless set), shows the sample
// shop; each shop the core has published answers at its handle's subdomain, such as
// http://zari.localhost:4100/, from Valkey at REDIS_URL. Urdu pages are under /ur/. Images under
// /images/ are placeholders drawn to size.

const themeDir = fileURLToPath(new URL('../../../../themes/hatti-base', import.meta.url));
const theme = loadTheme(await readThemeDir(themeDir));
const renderer = new PageRenderer(theme, {
  onError: (render, error) => console.error(`${render.id} not shown:`, (error as Error).message),
});
const site = new URL(process.env.STOREFRONT_URL ?? 'http://localhost:4100');
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const app = createStorefrontServer({
  theme,
  renderer,
  domain: site.hostname,
  redis,
  sample: new MemoryStore(sampleStore()),
  placeholders: true,
});

const port = Number(process.env.STOREFRONT_PORT ?? (site.port || 4100));
await app.listen({ port, host: '0.0.0.0' });
const at = (handle?: string) =>
  `${site.protocol}//${handle ? `${handle}.` : ''}${site.hostname}:${port}/`;
console.log(`The sample shop at ${at()} (Urdu: /ur/), and published shops at ${at('<handle>')}`);
