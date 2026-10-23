import { fileURLToPath } from 'node:url';
import { ErrorTracker, createLogger } from '@hatti/logger';
import { MemoryStore, type ShopDoc, type StoreDocuments } from '@hatti/storefront-data';
import { loadTheme, readThemeDir } from '@hatti/themes';
import { describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import { PageRenderer } from './render.js';
import { createStorefrontServer } from './server.js';

const THEME_DIR = fileURLToPath(new URL('../../../themes/hatti-base', import.meta.url));

/** The sample shop, whose documents cannot be read while `failing.now` is set. */
class FailingStore extends MemoryStore {
  constructor(
    private readonly kept: StoreDocuments,
    readonly failing = { now: false },
  ) {
    super(kept);
  }

  /** Each request's copy, failing with this one. */
  override fresh(): MemoryStore {
    return new FailingStore(this.kept, this.failing);
  }

  override shop(): Promise<ShopDoc> {
    if (this.failing.now) return Promise.reject(new Error('Connection is closed.'));
    return super.shop();
  }
}

describe("The storefront's errors sent to the error tracker (ADR-744)", () => {
  it('logs an answer that failed at error, with its route but not its address, and sends it', async () => {
    const sent: Record<string, unknown>[] = [];
    const tracker = new ErrorTracker({
      dsn: 'https://abc123@errors.hatti.pk/9',
      environment: 'production',
      fetch: (async (_url: string, init: RequestInit) => {
        const [, , event] = String(init.body).trimEnd().split('\n');
        sent.push(JSON.parse(event!) as Record<string, unknown>);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      name: 'storefront',
      destination: { write: (line: string) => lines.push(JSON.parse(line)) },
      errorTracker: tracker,
    });
    const theme = loadTheme(await readThemeDir(THEME_DIR));
    const store = new FailingStore(sampleStore());
    const app = createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      sample: store,
      logger,
    });
    try {
      // A page found, and one not: neither is an error, and requests are not logged one by one.
      expect((await app.inject({ url: '/', headers: { host: 'localhost' } })).statusCode).toBe(200);
      expect(
        (await app.inject({ url: '/pages/none', headers: { host: 'localhost' } })).statusCode,
      ).toBe(404);
      expect(lines.filter((line) => line.level === 'error')).toEqual([]);

      store.failing.now = true;
      const failed = await app.inject({
        url: `/products/${sampleStore().products[0]!.handle}?preview=secret-token`,
        headers: { host: 'localhost' },
      });
      expect(failed.statusCode).toBe(500);
      await tracker.flush();

      const errors = lines.filter((line) => line.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        name: 'storefront',
        msg: 'Connection is closed.',
        status: 500,
        method: 'GET',
        route: '/*',
        path: '/products',
        host: 'localhost',
        err: { type: 'Error', message: 'Connection is closed.' },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        logger: 'storefront',
        exception: { values: [{ type: 'Error', value: 'Connection is closed.' }] },
        extra: { route: '/*', path: '/products' },
      });
      // What a link's address holds stays out of the logs and the tracker.
      expect(JSON.stringify([lines, sent])).not.toContain('secret-token');
    } finally {
      await app.close();
    }
  });
});
