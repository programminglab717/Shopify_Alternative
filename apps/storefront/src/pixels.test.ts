import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { MemoryStore } from '@hatti/storefront-data';
import { loadTheme, readThemeDir, type Theme } from '@hatti/themes';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import {
  META_PIXEL_SCRIPT,
  browserIdsOf,
  metaPixelScript,
  pixelProduct,
  type PixelProduct,
} from './pixels.js';
import { PageRenderer, type PageRequest } from './render.js';

const THEME_DIR = fileURLToPath(new URL('../../../themes/hatti-base', import.meta.url));

/** A product as Liquid sees it, with the variants given, the first shown. */
const liquidProduct = (variants: { id: string; price: number }[]) => ({
  id: 'p-kurta',
  title: 'Chikankari Kurta <Eid>',
  variants,
  selected_or_first_available_variant: variants[0],
});

const KURTA: PixelProduct = pixelProduct(
  liquidProduct([
    { id: 'v-small', price: 4_990_00 },
    { id: 'v-large', price: 5_190_50 },
  ]),
)!;

/** A form of the page's, posting `fields` to `action`. */
const formTo = (action: string, fields: Record<string, string> = {}) => ({
  fields,
  getAttribute: (name: string) => (name === 'action' ? action : null),
});

/**
 * A page of the shop's loaded in a browser, its head's pixel script run: the pixel's calls so
 * far, the scripts the page added, and what a shopper does on it.
 */
function load(script: string, options: { fbq?: unknown } = {}) {
  const listeners: Record<string, ((event: object) => void)[]> = {};
  const added: { src: string; async: boolean }[] = [];
  const window: Record<string, unknown> = {
    document: {
      createElement: () => ({ src: '', async: false }),
      head: { appendChild: (element: { src: string; async: boolean }) => added.push(element) },
      addEventListener: (type: string, listener: (event: object) => void, capture: boolean) => {
        // Before the theme's own listeners, which may stop what the form does.
        expect(capture).toBe(true);
        (listeners[type] ??= []).push(listener);
      },
    },
    location: { href: 'https://www.zari.pk/products/kurta', origin: 'https://www.zari.pk' },
    URL,
    FormData: class {
      constructor(private readonly form: { fields: Record<string, string> }) {}
      get(name: string) {
        return this.form.fields[name] ?? null;
      }
    },
  };
  window.window = window;
  if (options.fbq) window.fbq = options.fbq;
  runInNewContext(script, window);
  const fbq = window.fbq as { queue: ArrayLike<unknown>[] };
  return {
    added,
    /** The pixel's calls, waiting for its script. */
    calls: () => JSON.parse(JSON.stringify(fbq.queue.map((call) => Array.from(call)))) as unknown[],
    submit: (form: ReturnType<typeof formTo>, submitter?: { name: string }) =>
      listeners.submit!.forEach((listener) => listener({ target: form, submitter })),
    click: (href: string) => {
      const link = { getAttribute: () => href };
      listeners.click!.forEach((listener) => listener({ target: { closest: () => link } }));
    },
  };
}

describe("The shop's Meta pixel", () => {
  it("loads Meta's script once, and tracks the page, and its product as the catalog feed names it", () => {
    const page = load(metaPixelScript('1234567890', KURTA));
    expect(page.added).toEqual([{ src: META_PIXEL_SCRIPT, async: true }]);
    expect(page.calls()).toEqual([
      ['init', '1234567890'],
      ['track', 'PageView'],
      [
        'track',
        'ViewContent',
        {
          // Its variants' group: the feed's item_group_id (ADR-142).
          content_ids: ['p-kurta'],
          content_type: 'product_group',
          content_name: 'Chikankari Kurta <Eid>',
          currency: 'PKR',
          value: 4990,
        },
      ],
    ]);
    // A product of one variant is that variant, the feed's item, which has no group.
    expect(pixelProduct(liquidProduct([{ id: 'v-only', price: 2_250_00 }]))!.view).toMatchObject({
      content_ids: ['v-only'],
      content_type: 'product',
      value: 2250,
    });
    // Another page: the page alone.
    expect(load(metaPixelScript('1234567890', null)).calls()).toEqual([
      ['init', '1234567890'],
      ['track', 'PageView'],
    ]);
    // Meta's script there already, the page's calls go to it.
    const queue: unknown[] = [];
    const fbq = Object.assign((...args: unknown[]) => queue.push(args), { queue: [] });
    const again = load(metaPixelScript('1234567890', null), { fbq });
    expect([again.added, queue.length]).toEqual([[], 2]);
  });

  it('tracks adding to the cart, valued when the page knows the price, and leaving for checkout', () => {
    const page = load(metaPixelScript('1234567890', KURTA));
    const tracked = () => page.calls().slice(3);

    page.submit(formTo('/cart/add', { id: 'v-large', quantity: '2' }));
    // In Urdu too, a variant the page does not price, and a quantity not typed.
    page.submit(formTo('/ur/cart/add', { id: 'v-other' }));
    expect(tracked()).toEqual([
      [
        'track',
        'AddToCart',
        {
          content_ids: ['v-large'],
          content_type: 'product',
          contents: [{ id: 'v-large', quantity: 2 }],
          currency: 'PKR',
          value: 10381,
        },
      ],
      [
        'track',
        'AddToCart',
        {
          content_ids: ['v-other'],
          content_type: 'product',
          contents: [{ id: 'v-other', quantity: 1 }],
        },
      ],
    ]);

    // The cart's checkout button, a form to checkout and a link to it; and nothing else.
    const before = tracked().length;
    page.submit(formTo('/cart'), { name: 'checkout' });
    page.submit(formTo('https://www.zari.pk/ur/checkout'));
    page.click('/checkout');
    expect(tracked().slice(before)).toEqual([
      ['track', 'InitiateCheckout'],
      ['track', 'InitiateCheckout'],
      ['track', 'InitiateCheckout'],
    ]);
    page.submit(formTo('/cart'), { name: 'update' });
    page.submit(formTo('/cart/add', {}));
    page.submit(formTo('https://elsewhere.pk/cart/add', { id: 'v-large' }));
    page.submit(formTo('/contact', { id: 'v-large' }));
    page.click('https://elsewhere.pk/checkout');
    page.click('/products/checkout-bag');
    expect(tracked()).toHaveLength(before + 3);
  });

  it("passes on the pixel's browser and click IDs from the shopper's cookies, as Meta made them", () => {
    expect(
      browserIdsOf(
        'cart=secret; _fbp=fb.1.1727856000000.1116446470; _fbc=fb.1.1727856000000.IwAR2x_Y-z',
      ),
    ).toEqual({ fbp: 'fb.1.1727856000000.1116446470', fbc: 'fb.1.1727856000000.IwAR2x_Y-z' });
    expect(browserIdsOf('_fbp=fb.1.1727856000000.1116446470')).toEqual({
      fbp: 'fb.1.1727856000000.1116446470',
    });
    expect(browserIdsOf('_fbp=<script>; _fbc=fb.x.1.2')).toBeUndefined();
    expect(browserIdsOf(undefined)).toBeUndefined();
  });

  describe("on the shop's pages", () => {
    let theme: Theme;
    beforeAll(async () => {
      theme = loadTheme(await readThemeDir(THEME_DIR));
    });

    const render = async (request: PageRequest, metaPixelId?: string) => {
      const sample = sampleStore();
      const store = new MemoryStore({ ...sample, shop: { ...sample.shop, metaPixelId } });
      const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
      return (await renderer.render(request, store.fresh(0))).html;
    };
    const head = (html: string) => html.slice(0, html.indexOf('</head>'));

    it("is in shoppers' pages' heads while the shop has one, and not in staff's previews", async () => {
      const product = sampleStore().products[0]!;
      const page = await render({ path: `/products/${product.handle}` }, '1234567890');
      expect(head(page)).toContain('<script data-hatti-pixel>');
      expect(head(page)).toContain(`"content_ids":["${product.id}"]`);
      expect(head(page)).toContain('"content_type":"product_group"');
      // Beside the visits' script (ADR-139).
      expect(head(page)).toContain('<script data-hatti-visits>');
      // Another page has no product to tell of.
      expect(head(await render({ path: '/' }, '1234567890'))).toContain('var product = null;');

      for (const request of [
        { path: '/', preview: { name: 'Winter' } },
        { path: '/', editor: { origins: ['https://admin.hatti.pk'] } },
      ]) {
        expect(await render(request, '1234567890')).not.toContain('data-hatti-pixel');
      }
      expect(await render({ path: '/' })).not.toContain('data-hatti-pixel');
    });
  });
});
