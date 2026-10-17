import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { MemoryStore } from '@hatti/storefront-data';
import { loadTheme, readThemeDir, type Theme } from '@hatti/themes';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import {
  GOOGLE_TAG_SCRIPT,
  META_PIXEL_SCRIPT,
  TIKTOK_PIXEL_SCRIPT,
  browserIdsOf,
  consentScript,
  googleTagScript,
  metaPixelScript,
  onceConsented,
  pixelProduct,
  tiktokPixelScript,
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
function load(script: string, options: { fbq?: unknown; ttq?: unknown; gtag?: unknown } = {}) {
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
  if (options.ttq) window.ttq = options.ttq;
  if (options.gtag) window.gtag = options.gtag;
  runInNewContext(script, window);
  const fbq = window.fbq as { queue: ArrayLike<unknown>[] } | undefined;
  const dataLayer = window.dataLayer as ArrayLike<unknown>[] | undefined;
  return {
    added,
    /** The pixel's calls, waiting for its script: Meta's queue, Google's data layer, else TikTok's. */
    calls: () =>
      JSON.parse(
        JSON.stringify(
          fbq
            ? fbq.queue.map((call) => Array.from(call))
            : dataLayer
              ? Array.from(dataLayer, (call) => Array.from(call))
              : Array.from(window.ttq as ArrayLike<unknown>),
        ),
      ) as unknown[],
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
    // TikTok's pixel's browser ID too (ADR-543).
    expect(browserIdsOf('_ttp=2RjN8g3hW6yFZ8JQ0Gk6p1Lq5Xv; _fbp=x')).toEqual({
      ttp: '2RjN8g3hW6yFZ8JQ0Gk6p1Lq5Xv',
    });
    expect(browserIdsOf('_ttp=<script>alert(1)</script>')).toBeUndefined();
    // And Google's tag's (ADR-548), its cookie as it is.
    expect(browserIdsOf('_ga=GA1.1.1903423857.1760680000; _ga_AB12CD34EF=GS2.1.s1')).toEqual({
      ga: 'GA1.1.1903423857.1760680000',
    });
    expect(browserIdsOf('_ga=GA1.1.x.<y>')).toBeUndefined();
    expect(browserIdsOf(undefined)).toBeUndefined();
  });

  describe("on the shop's pages", () => {
    let theme: Theme;
    beforeAll(async () => {
      theme = loadTheme(await readThemeDir(THEME_DIR));
    });

    const render = async (
      request: PageRequest,
      metaPixelId?: string,
      tiktokPixelCode?: string,
      googleMeasurementId?: string,
    ) => {
      const sample = sampleStore();
      const store = new MemoryStore({
        ...sample,
        shop: { ...sample.shop, metaPixelId, tiktokPixelCode, googleMeasurementId },
      });
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

    it("loads TikTok's pixel beside Meta's, or alone, while the shop has it (ADR-543)", async () => {
      const both = head(await render({ path: '/' }, '1234567890', 'CABC123DEF456GHI789J'));
      expect(both.split('<script data-hatti-pixel>')).toHaveLength(3);
      expect(both).toContain('"CABC123DEF456GHI789J"');
      const alone = head(await render({ path: '/' }, undefined, 'CABC123DEF456GHI789J'));
      expect(alone.split('<script data-hatti-pixel>')).toHaveLength(2);
      expect(alone).not.toContain('fbevents');
      expect(
        await render({ path: '/', preview: { name: 'Winter' } }, undefined, 'CABC123DEF456GHI789J'),
      ).not.toContain('data-hatti-pixel');
    });

    it("loads Google's tag beside the pixels, or alone, while the shop has Google (ADR-548)", async () => {
      const all = head(
        await render({ path: '/' }, '1234567890', 'CABC123DEF456GHI789J', 'G-AB12CD34EF'),
      );
      expect(all.split('<script data-hatti-pixel>')).toHaveLength(4);
      expect(all).toContain('"G-AB12CD34EF"');
      const alone = head(await render({ path: '/' }, undefined, undefined, 'G-AB12CD34EF'));
      expect(alone.split('<script data-hatti-pixel>')).toHaveLength(2);
      expect(alone).toContain('googletagmanager');
      expect(
        await render(
          { path: '/', editor: { origins: ['https://admin.hatti.pk'] } },
          undefined,
          undefined,
          'G-AB12CD34EF',
        ),
      ).not.toContain('data-hatti-pixel');
    });
  });
});

describe("The shop's TikTok pixel (ADR-543)", () => {
  it("loads TikTok's script once, and tracks the page and its product", () => {
    const page = load(tiktokPixelScript('CABC123DEF456GHI789J', KURTA));
    expect(page.added).toEqual([
      { src: `${TIKTOK_PIXEL_SCRIPT}?sdkid=CABC123DEF456GHI789J&lib=ttq`, async: true },
    ]);
    expect(page.calls()).toEqual([
      ['page'],
      [
        'track',
        'ViewContent',
        {
          contents: [{ content_id: 'p-kurta', content_name: 'Chikankari Kurta <Eid>' }],
          content_type: 'product_group',
          currency: 'PKR',
          value: 4990,
        },
      ],
    ]);
    // TikTok's script there already, the page's calls go to it.
    const calls: unknown[] = [];
    const ttq = { page: () => calls.push('page'), track: () => calls.push('track') };
    const again = load(tiktokPixelScript('CABC123DEF456GHI789J', null), { ttq });
    expect([again.added, calls]).toEqual([[], ['page']]);
  });

  it("tracks adding to the cart and leaving for checkout, as Meta's does", () => {
    const page = load(tiktokPixelScript('CABC123DEF456GHI789J', KURTA));
    page.submit(formTo('/cart/add', { id: 'v-large', quantity: '2' }));
    page.submit(formTo('/cart/add', { id: 'v-other' }));
    page.click('/checkout');
    page.click('/products/checkout-bag');
    expect(page.calls().slice(2)).toEqual([
      [
        'track',
        'AddToCart',
        {
          contents: [{ content_id: 'v-large', quantity: 2 }],
          content_type: 'product',
          currency: 'PKR',
          value: 10381,
        },
      ],
      [
        'track',
        'AddToCart',
        { contents: [{ content_id: 'v-other', quantity: 1 }], content_type: 'product' },
      ],
      ['track', 'InitiateCheckout'],
    ]);
  });
});

describe("The shop's Google tag (ADR-548)", () => {
  it("loads Google's script once, configured for the stream, and tracks the page's product", () => {
    const page = load(googleTagScript('G-AB12CD34EF', KURTA));
    expect(page.added).toEqual([{ src: `${GOOGLE_TAG_SCRIPT}?id=G-AB12CD34EF`, async: true }]);
    expect(page.calls()).toEqual([
      ['js', expect.any(String)],
      ['config', 'G-AB12CD34EF'],
      [
        'event',
        'view_item',
        {
          currency: 'PKR',
          value: 4990,
          items: [{ item_id: 'p-kurta', item_name: 'Chikankari Kurta <Eid>' }],
        },
      ],
    ]);
    // Google's tag there already, the page's calls go to it.
    const calls: unknown[] = [];
    const again = load(googleTagScript('G-AB12CD34EF', null), {
      gtag: (...args: unknown[]) => calls.push(args[0]),
    });
    expect([again.added, calls]).toEqual([[], ['config']]);
  });

  it("tracks adding to the cart and leaving for checkout by Google's names", () => {
    const page = load(googleTagScript('G-AB12CD34EF', KURTA));
    page.submit(formTo('/ur/cart/add', { id: 'v-large', quantity: '2' }));
    page.submit(formTo('/cart', {}), { name: 'checkout' });
    expect(page.calls().slice(3)).toEqual([
      [
        'event',
        'add_to_cart',
        { items: [{ item_id: 'v-large', quantity: 2 }], currency: 'PKR', value: 10381 },
      ],
      ['event', 'begin_checkout'],
    ]);
  });
});

/** An element of a page in the fake browser: what the consent banner makes of it. */
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, (() => void)[]> = {};
  textContent = '';
  href = '';
  id = '';
  dir = '';
  type = '';
  src = '';
  async = false;
  removed = false;
  constructor(readonly tag: string) {}
  append(...children: FakeElement[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(type: string, listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  remove() {
    this.removed = true;
  }
  /** Its words and its children's, as a shopper reads them. */
  get words(): string {
    return this.textContent + this.children.map((child) => child.words).join('');
  }
}

/**
 * A page of the shop's in a browser carrying `cookie`, its head's `scripts` run in order: the
 * banner it shows, the cookies it sets, and Meta's pixel's calls.
 */
function browse(scripts: string[], cookie = '') {
  const body = new FakeElement('body');
  const set: string[] = [];
  const window: Record<string, unknown> = {
    document: {
      body,
      get cookie() {
        return cookie;
      },
      set cookie(value: string) {
        set.push(value);
      },
      createElement: (tag: string) => new FakeElement(tag),
      head: { appendChild: () => undefined },
      addEventListener: () => undefined,
    },
    location: {
      href: 'https://www.zari.pk/',
      origin: 'https://www.zari.pk',
      protocol: 'https:',
    },
    URL,
  };
  window.window = window;
  for (const script of scripts) runInNewContext(script, window);
  const banner = () =>
    body.children.find((child) => child.id === 'hatti-consent' && !child.removed);
  const button = (consent: string) =>
    banner()!.children.find((child) => child.attributes['data-consent'] === consent)!;
  return {
    banner,
    set,
    click: (consent: 'granted' | 'denied') =>
      button(consent).listeners.click!.forEach((run) => run()),
    calls: () => {
      const fbq = window.fbq as { queue: ArrayLike<unknown>[] } | undefined;
      return fbq ? fbq.queue.map((call) => Array.from(call)[0]) : null;
    },
  };
}

describe("The shop's consent banner (ADR-551)", () => {
  const pixel = onceConsented(metaPixelScript('1234567890', null));

  it('asks the shopper first, and loads the pixels once they accept', () => {
    const page = browse([consentScript('en', '/policies/privacy-policy'), pixel]);
    expect(page.calls()).toBeNull();
    const banner = page.banner()!;
    expect(banner.attributes).toEqual({ role: 'region', 'aria-label': 'Cookies' });
    expect(banner.dir).toBe('ltr');
    expect(banner.words).toContain('This store uses cookies from its ad platforms');
    expect(banner.children[0]!.children[0]).toMatchObject({
      tag: 'a',
      href: '/policies/privacy-policy',
      textContent: 'Privacy policy',
    });
    expect(banner.children.slice(1).map((each) => each.textContent)).toEqual(['Decline', 'Accept']);

    page.click('granted');
    expect(page.calls()).toEqual(['init', 'track']);
    expect(page.banner()).toBeUndefined();
    expect(page.set).toEqual([
      'hatti_consent=granted; path=/; max-age=15552000; samesite=lax; secure',
    ]);
  });

  it('loads none when they decline, and asks no more once they answered', () => {
    const declined = browse([consentScript('en', null), pixel]);
    declined.click('denied');
    expect(declined.calls()).toBeNull();
    expect(declined.banner()).toBeUndefined();
    expect(declined.set).toEqual([
      'hatti_consent=denied; path=/; max-age=15552000; samesite=lax; secure',
    ]);

    const before = browse([consentScript('en', null), pixel], 'cart=c1; hatti_consent=denied');
    expect(before.banner()).toBeUndefined();
    expect(before.calls()).toBeNull();
    const accepted = browse([consentScript('en', null), pixel], 'hatti_consent=granted; cart=c1');
    expect(accepted.banner()).toBeUndefined();
    expect(accepted.calls()).toEqual(['init', 'track']);
    // Another value is no answer.
    expect(browse([consentScript('en', null), pixel], 'hatti_consent=yes').banner()).toBeDefined();
  });

  it('asks in Urdu on Urdu pages, without a policy link the shop has none for', () => {
    const banner = browse([consentScript('ur', null), pixel]).banner()!;
    expect(banner.dir).toBe('rtl');
    expect(banner.words).toContain('کوکیز استعمال کرتا ہے');
    expect(banner.children[0]!.children).toEqual([]);
    expect(banner.children.slice(1).map((each) => each.textContent)).toEqual([
      'انکار کریں',
      'قبول کریں',
    ]);
  });

  it('names no browser for the order when the shop asks and the shopper did not accept', () => {
    const ids = '_fbp=fb.1.1727856000000.1116446470; _ga=GA1.1.1903423857.1760680000';
    expect(browserIdsOf(ids, true)).toEqual({ consent: 'denied' });
    expect(browserIdsOf(`${ids}; hatti_consent=denied`, true)).toEqual({ consent: 'denied' });
    expect(browserIdsOf(`${ids}; hatti_consent=granted`, true)).toEqual({
      fbp: 'fb.1.1727856000000.1116446470',
      ga: 'GA1.1.1903423857.1760680000',
    });
    // A shop that does not ask passes them on as before.
    expect(browserIdsOf(`${ids}; hatti_consent=denied`)).toEqual({
      fbp: 'fb.1.1727856000000.1116446470',
      ga: 'GA1.1.1903423857.1760680000',
    });
  });

  it('is on the pages of a shop that asks, before its pixels, which wait for it', async () => {
    const theme = loadTheme(await readThemeDir(THEME_DIR));
    const render = async (shop: Record<string, unknown>, path = '/') => {
      const sample = sampleStore();
      const store = new MemoryStore({ ...sample, shop: { ...sample.shop, ...shop } });
      const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
      const html = (await renderer.render({ path }, store.fresh(0))).html;
      return html.slice(0, html.indexOf('</head>'));
    };
    const asking = await render({
      metaPixelId: '1234567890',
      googleMeasurementId: 'G-AB12CD34EF',
      consentBanner: true,
      policies: ['privacy_policy'],
    });
    expect(asking.indexOf('<script data-hatti-consent>')).toBeGreaterThan(-1);
    expect(asking.indexOf('<script data-hatti-consent>')).toBeLessThan(
      asking.indexOf('<script data-hatti-pixel>'),
    );
    expect(asking.split('<script data-hatti-pixel>window.hattiConsent && ')).toHaveLength(3);
    expect(asking).toContain('"/policies/privacy-policy"');
    expect(asking).toContain('#hatti-consent{');
    // Without pixels there is nothing to ask of.
    expect(await render({ consentBanner: true })).not.toContain('data-hatti-consent');
    // Without asking, the pixels load as before.
    const loading = await render({ metaPixelId: '1234567890' });
    expect(loading).not.toContain('data-hatti-consent');
    expect(loading).toContain('<script data-hatti-pixel>(function () {');
  });
});
