import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkTheme, productIn } from './check.js';
import { run } from './main.js';

/** A page as a theme renders one: its language, a title, a heading and `body`. */
const page = (body: string, lang = 'en') =>
  `<!doctype html><html lang="${lang}"${lang === 'ur' ? ' dir="rtl"' : ''}><head>` +
  `<title>Zari Fashions</title></head><body><main><h1>Zari Fashions</h1>${body}</main>` +
  `<script>document.title = 'not run'</script></body></html>`;

/** A shop's pages, each asked for kept; `product` is its product page's body. */
function shop(product: string) {
  const asked: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    asked.push(url);
    const { pathname } = new URL(url);
    const lang = pathname.startsWith('/ur') ? 'ur' : 'en';
    const at = pathname.replace(/^\/ur/, '') || '/';
    if (at === '/collections/all') {
      return new Response(page('<a href="/products/lawn-suit?variant=1">Lawn suit</a>', lang));
    }
    if (at === '/products/lawn-suit') return new Response(page(product, lang));
    if (['/', '/cart', '/search'].includes(at)) return new Response(page('<p>Welcome</p>', lang));
    return new Response('Not found', { status: 404 });
  });
  return { asked, fetch: fetch as unknown as typeof globalThis.fetch };
}

describe('hatti theme check (ADR-968)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads each kind of page, in English and in Urdu, with the preview's token", async () => {
    const { asked, fetch } = shop('<img src="/a.jpg" alt="Lawn suit, mint">');
    const result = await checkTheme('https://zari.hatti.pk/?preview=hpv_1', { fetch });
    expect(result).toEqual({ pages: 10, problems: [] });
    expect(asked.map((url) => url.replace('https://zari.hatti.pk', ''))).toEqual([
      '/?preview=hpv_1',
      '/collections/all?preview=hpv_1',
      '/products/lawn-suit?preview=hpv_1',
      '/cart?preview=hpv_1',
      '/search?q=a&preview=hpv_1',
      '/ur/?preview=hpv_1',
      '/ur/collections/all?preview=hpv_1',
      // The Urdu catalogue linking to English pages: the product's Urdu page is read.
      '/ur/products/lawn-suit?preview=hpv_1',
      '/ur/cart?preview=hpv_1',
      '/ur/search?q=a&preview=hpv_1',
    ]);
  });

  it('says each rule a page breaks, and where', async () => {
    const { fetch } = shop('<img src="/a.jpg"><button></button>');
    const { problems } = await checkTheme('https://zari.hatti.pk/?preview=hpv_1', { fetch });
    expect(problems.map((each) => `${each.page} ${each.rule}`).sort()).toEqual([
      'en /products/lawn-suit button-name',
      'en /products/lawn-suit image-alt',
      'ur /ur/products/lawn-suit button-name',
      'ur /ur/products/lawn-suit image-alt',
    ]);
    expect(problems.find((each) => each.rule === 'image-alt')).toMatchObject({
      impact: 'critical',
      elements: ['<img src="/a.jpg">'],
    });
  });

  it('finds the first product a catalogue links to, whole links too', () => {
    expect(productIn('<a href="https://zari.pk/ur/products/khussa-1">', '/ur')).toBe(
      '/ur/products/khussa-1',
    );
    expect(productIn('<a href="/collections/eid">', '')).toBeNull();
  });

  it('checks a preview link without a token, failing on what it finds', async () => {
    vi.stubGlobal('fetch', shop('<img src="/a.jpg">').fetch);
    const logged: string[] = [];
    const errors: string[] = [];
    const out = {
      log: (line: string) => logged.push(line),
      error: (line: string) => errors.push(line),
    };
    const code = await run(
      ['theme', 'check', '--url', 'https://zari.hatti.pk/?preview=hpv_1'],
      {},
      out,
    );
    expect(code).toBe(1);
    expect(errors).toEqual([
      'en /products/lawn-suit: image-alt (critical): Images must have alternative text',
      '    <img src="/a.jpg">',
      'ur /ur/products/lawn-suit: image-alt (critical): Images must have alternative text',
      '    <img src="/a.jpg">',
      '2 accessibility problems on 10 pages.',
    ]);
    expect(logged).toContain('Checking ur /ur/cart');
  });

  it('says a page that does not answer, as a preview gone stale', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Gone', { status: 404 })),
    );
    const errors: string[] = [];
    const out = { log: () => undefined, error: (line: string) => errors.push(line) };
    const code = await run(
      ['theme', 'check', '--url', 'https://zari.hatti.pk/?preview=old'],
      {},
      out,
    );
    expect(code).toBe(1);
    expect(errors).toEqual(['en / answered 404: is the preview link current?']);
  });
});
