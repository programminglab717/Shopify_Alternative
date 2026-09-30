import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { MemoryStore } from '../documents.js';
import { sampleStore } from '../fixtures.js';
import { PageRenderer } from '../render.js';
import { loadTheme, readThemeDir } from '../theme.js';

// Serves the sample shop in Hatti Base, to look at pages as a phone would: pnpm serve, then
// http://localhost:4100/ (and /ur/ for Urdu). Images are placeholders drawn to size.

const themeDir = fileURLToPath(new URL('../../../../themes/hatti-base', import.meta.url));
const theme = loadTheme(await readThemeDir(themeDir));
const renderer = new PageRenderer(theme, {
  onError: (render, error) => console.error(`${render.id} not shown:`, (error as Error).message),
});
const store = new MemoryStore(sampleStore());
const app = Fastify();

app.get('/assets/:version/:file', async (request, reply) => {
  const { file } = request.params as { file: string };
  const source = theme.files[`assets/${file}`];
  if (source === undefined) return reply.code(404).send();
  const type = file.endsWith('.css') ? 'text/css' : 'application/javascript';
  return reply.type(`${type}; charset=utf-8`).send(source);
});

app.get('/images/*', async (request, reply) => {
  const path = (request.params as { '*': string })['*'];
  const hue = createHash('sha256').update(path).digest()[0]! * 1.4;
  const [width, height] = path.startsWith('banners/') ? [5, 3] : [4, 5];
  const label = path
    .split('/')
    .at(-1)!
    .replace(/\.\w+$/, '')
    .replace(/-/g, ' ')
    .slice(0, 28);
  return reply
    .type('image/svg+xml')
    .send(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * 100} ${height * 100}">` +
        `<rect width="100%" height="100%" fill="hsl(${hue} 45% 78%)"/>` +
        `<text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="14" ` +
        `fill="hsl(${hue} 40% 30%)">${label}</text></svg>`,
    );
});

app.get('/*', async (request, reply) => {
  const url = new URL(request.url, 'http://localhost');
  const urdu = url.pathname === '/ur' || url.pathname.startsWith('/ur/');
  const path = urdu ? url.pathname.slice(3) || '/' : url.pathname;
  const page = await renderer.render(
    { path, query: Object.fromEntries(url.searchParams), locale: urdu ? 'ur' : 'en' },
    store.fresh(),
  );
  return reply.code(page.status).type('text/html; charset=utf-8').send(page.html);
});

const port = Number(process.env.PORT ?? 4100);
await app.listen({ port, host: '0.0.0.0' });
console.log(`Hatti Base on http://localhost:${port}/ (Urdu: /ur/)`);
