import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BuildQueue,
  MemoryStore,
  ShopDirectory,
  StorefrontActivity,
  StorefrontKeys,
  localDay,
  pathTag,
  type ProductDoc,
  type ShopDoc,
  type StoreData,
  type StoreDocuments,
  type ThemeDoc,
} from '@hatti/storefront-data';
import {
  PRODUCT_FEED_PATH,
  StorefrontApiError,
  type CartActionName,
  type CartActionResult,
  type CartBodies,
  type CartError,
  type CartJson,
  type CheckoutClient,
  type CheckoutPageResponse,
  type PaymentLinkOpenResponse,
  type ContentSearchOptions,
  type ContentSearchResponse,
  type SearchOptions,
  type CommentRequest,
  type CommentResult,
  type SignUpRequest,
  type SignUpResult,
  type StorefrontVisit,
  type ThemePreviewResponse,
} from '@hatti/storefront-api';
import type { InjectOptions } from 'fastify';
import { Redis } from 'ioredis';
import { Parser } from 'liquidjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { passwordVerifier } from '@hatti/crypto';
import { sampleStore } from './fixtures.js';
import { linkKey } from './link-page.js';
import { PageRenderer } from './render.js';
import {
  createStorefrontServer,
  handleOf,
  localPath,
  redirectedTo,
  ShopResolver,
  ShopThemes,
  type StorefrontServerOptions,
} from './server.js';
import { loadTheme, readThemeDir, type Theme } from '@hatti/themes';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

const THEME_DIR = fileURLToPath(new URL('../../../themes/hatti-base', import.meta.url));

/** A home page of a banner with `heading`, as a shop would save it. */
const bannerHome = (heading: string) =>
  JSON.stringify({
    sections: {
      banner: {
        type: 'image-banner',
        blocks: { heading: { type: 'heading', settings: { heading } } },
        block_order: ['heading'],
      },
    },
    order: ['banner'],
  });

describe('Finding the shop a host names', () => {
  it('reads the handle from a subdomain of the platform', () => {
    expect(handleOf('zari.hatti.pk', 'hatti.pk')).toBe('zari');
    expect(handleOf('Zari.Hatti.pk:443', 'hatti.pk')).toBe('zari');
    expect(handleOf('zari-fashions.localhost:4100', 'localhost')).toBe('zari-fashions');
    expect(handleOf('zari.hatti.pk.', 'hatti.pk')).toBe('zari');
    // The platform's own domain, and hosts that are no shop's subdomain.
    expect(handleOf('hatti.pk', 'hatti.pk')).toBeNull();
    expect(handleOf('localhost:4100', 'localhost')).toBeNull();
    for (const host of ['zari.com', 'www.zari.hatti.pk', 'xn--zari.hatti.pk', '-zari.hatti.pk']) {
      expect(handleOf(host, 'hatti.pk'), host).toBeUndefined();
    }
    expect(handleOf('evilhatti.pk', 'hatti.pk')).toBeUndefined();
  });

  it('remembers what the directory says for a few seconds', async () => {
    const asked: string[] = [];
    const shops = new ShopResolver(
      {
        find: async (handle: string) => {
          asked.push(handle);
          return handle === 'zari' ? 'shop-1' : null;
        },
      },
      60_000,
      2,
    );
    expect(await shops.find('zari')).toBe('shop-1');
    expect(await shops.find('zari')).toBe('shop-1');
    expect(await shops.find('nobody')).toBeNull();
    expect(await shops.find('nobody')).toBeNull();
    expect(asked).toEqual(['zari', 'nobody']);
    // It keeps two answers: a third handle pushes out the oldest.
    await shops.find('bazaar');
    await shops.find('zari');
    expect(asked).toEqual(['zari', 'nobody', 'bazaar', 'zari']);
  });
});

describe('Where forms and links may send shoppers', () => {
  it('sends them only along paths on the shop, as browsers read them', () => {
    expect(localPath('/collections/lawn?sort_by=price#grid')).toBe(
      '/collections/lawn?sort_by=price#grid',
    );
    expect(localPath('/collections/عید')).toBe('/collections/%D8%B9%DB%8C%D8%AF');
    // A browser drops a tab, reads a backslash as a slash, and `//` as another host.
    const tab = String.fromCharCode(9);
    const away = [
      '//evil.example',
      `/${tab}/evil.example`,
      '/\\evil.example',
      '/..//evil.example',
      'https://evil.example/',
      'evil.example',
      '',
      null,
    ];
    for (const path of away) expect(localPath(path), String(path)).toBeNull();
  });
});

describe("Where a shop's redirects send shoppers", () => {
  it("keeps the shopper's language and query, and writes the address as a header carries it", () => {
    expect(redirectedTo('/products/lawn', false, '/products/old?utm_source=fb')).toBe(
      '/products/lawn?utm_source=fb',
    );
    // The target's own query wins; a fragment stays last.
    expect(redirectedTo('/collections/eid?sort_by=price', false, '/x?page=2')).toBe(
      '/collections/eid?sort_by=price',
    );
    expect(redirectedTo('/pages/faq#delivery', false, '/x?a=1')).toBe('/pages/faq?a=1#delivery');
    expect(redirectedTo('/', true, '/ur/x')).toBe('/ur');
    expect(redirectedTo('/?a=1', true, '/ur/x')).toBe('/ur?a=1');
    expect(redirectedTo('/pages/faq', true, '/ur/x')).toBe('/ur/pages/faq');
    // A target in Urdu already, or elsewhere, as it is.
    expect(redirectedTo('/ur/pages/faq', true, '/ur/x')).toBe('/ur/pages/faq');
    expect(redirectedTo('/urdu-poetry', true, '/ur/x')).toBe('/ur/urdu-poetry');
    expect(redirectedTo('https://zari.pk/شلوار', true, '/ur/x?')).toBe(
      'https://zari.pk/%D8%B4%D9%84%D9%88%D8%A7%D8%B1',
    );
    // A preview's token stays on the shop; nothing a header cannot carry gets into one.
    expect(redirectedTo('https://instagram.com/zari', false, '/x?preview=abc&utm_source=fb')).toBe(
      'https://instagram.com/zari?utm_source=fb',
    );
    expect(redirectedTo('/pages/faq', false, '/x?preview')).toBe('/pages/faq');
    const [cr, lf] = [String.fromCharCode(13), String.fromCharCode(10)];
    expect(redirectedTo(`/pages/faq${cr}${lf}set-cookie:x`, false, '/x')).toBe(
      '/pages/faq%0D%0Aset-cookie:x',
    );
  });
});

describe('Starting a storefront', () => {
  it('renders the sample pages before it listens, so the first pages served parse nothing', async () => {
    const theme = loadTheme(await readThemeDir(THEME_DIR));
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const app = createStorefrontServer({
      theme,
      renderer,
      domain: 'localhost',
      sample: new MemoryStore(sampleStore()),
    });
    // Templates and snippets alike, each parsed by a Parser of its own.
    const parse = vi.spyOn(Parser.prototype, 'parse');
    await app.ready();
    const atStart = parse.mock.calls.length;
    expect(atStart).toBeGreaterThan(0);
    const product = sampleStore().products[5]!.handle;
    for (const url of ['/', '/ur/', '/collections/khussa', `/products/${product}`, '/cart']) {
      const page = await app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
      expect(page.statusCode, url).toBe(200);
    }
    expect(parse.mock.calls.length).toBe(atStart);
    parse.mockRestore();
    await app.close();
  });
});

describe("Shops' themes", () => {
  let base: Theme;
  beforeAll(async () => {
    base = loadTheme(await readThemeDir(THEME_DIR));
  });

  /** A shop's store, holding `doc` as its theme, counting how often it is fetched. */
  const holding = (doc: ThemeDoc | null) => {
    const store = {
      doc,
      fetched: 0,
      theme: async () => {
        store.fetched += 1;
        return store.doc;
      },
    };
    return store;
  };
  const shopWith = (theme: ShopDoc['theme']): ShopDoc => ({ ...sampleStore().shop, theme });
  const doc = (version: number, heading: string): ThemeDoc => ({
    id: 'thm-1',
    version,
    base: 'hatti-base',
    files: { 'templates/index.json': bannerHome(heading) },
  });
  const home = (theme: Theme) => theme.files['templates/index.json'];

  it('lays a theme over the platform theme once per version, for pages at once and after', async () => {
    const themes = new ShopThemes(base);
    const store = holding(doc(1, 'One'));
    const data = store as unknown as StoreData;
    const [first, second] = await Promise.all([
      themes.for('s1', shopWith({ id: 'thm-1', version: 1 }), data),
      themes.for('s1', shopWith({ id: 'thm-1', version: 1 }), data),
    ]);
    expect(second).toBe(first);
    expect(await themes.for('s1', shopWith({ id: 'thm-1', version: 1 }), data)).toBe(first);
    expect(home(first)).toBe(bannerHome('One'));
    expect(store.fetched).toBe(1);
    // No theme, or documents from before shops had them: the platform theme, fetching nothing.
    expect(await themes.for('s1', shopWith(null), data)).toBe(base);
    const { theme: _, ...older } = shopWith(null);
    expect(await themes.for('s1', older as ShopDoc, data)).toBe(base);
    expect(store.fetched).toBe(1);

    // The shop's document names version 2 before its theme's is written: version 1 shows, but is
    // not kept as version 2.
    const early = await themes.for('s1', shopWith({ id: 'thm-1', version: 2 }), data);
    expect(home(early)).toBe(bannerHome('One'));
    store.doc = doc(2, 'Two');
    const next = await themes.for('s1', shopWith({ id: 'thm-1', version: 2 }), data);
    expect(home(next)).toBe(bannerHome('Two'));
    await themes.for('s1', shopWith({ id: 'thm-1', version: 2 }), data);
    expect(store.fetched).toBe(3);
  });

  it('keeps themes up to a size, letting the least recently used go first', async () => {
    const size = bannerHome('Shop 1').length;
    const themes = new ShopThemes(base, { maxBytes: size * 2 });
    const stores = new Map(['s1', 's2', 's3'].map((id) => [id, holding(doc(1, `Shop ${id[1]}`))]));
    const show = (shopId: string) =>
      themes.for(shopId, shopWith({ id: 'thm-1', version: 1 }), stores.get(shopId) as never);
    await show('s1');
    await show('s2');
    await show('s1');
    await show('s3');
    // s2 was used least recently: making room for s3 let it go.
    await show('s1');
    await show('s2');
    expect([...stores.values()].map((store) => store.fetched)).toEqual([1, 2, 1]);
  });
});

/**
 * Carts as the core would keep them, as far as a test needs: each action recorded, and answered
 * with `answer`'s cart, kept under its token.
 */
class FakeCore {
  readonly actions: { token: string | null; action: CartActionName; body: unknown }[] = [];
  readonly kept = new Map<string, CartJson>();
  answer: (action: CartActionName) => CartActionResult | Error = () => new Error('No answer');
  /** The carts checkouts were started for, with the visits passed, and the pages asked for. */
  readonly started: (string | null)[] = [];
  readonly visits: StorefrontVisit[][] = [];
  readonly pages: {
    token: string;
    form: Record<string, string> | null;
    client?: CheckoutClient;
  }[] = [];
  page: CheckoutPageResponse | Error = new Error('No page');

  async read(_shopId: string, token: string | null): Promise<CartJson | null> {
    return (token && this.kept.get(token)) || null;
  }

  async act<A extends CartActionName>(
    _shopId: string,
    token: string | null,
    action: A,
    body: CartBodies[A],
  ): Promise<CartActionResult> {
    this.actions.push({ token, action, body });
    const answer = this.answer(action);
    if (answer instanceof Error) throw answer;
    if (answer.ok && answer.token) this.kept.set(answer.token, answer.cart);
    return answer;
  }

  /** A checkout for a cart with something in it; EMPTY otherwise. */
  async startCheckout(
    _shopId: string,
    token: string | null,
    visits: StorefrontVisit[] = [],
  ): Promise<{ ok: true; path: string; url: string } | { ok: false; error: CartError }> {
    this.started.push(token);
    this.visits.push(visits);
    const cart = token ? this.kept.get(token) : undefined;
    return cart && cart.itemCount > 0
      ? { ok: true, path: '/checkouts/c-secret', url: 'http://core.test/checkouts/c-secret' }
      : { ok: false, error: { code: 'EMPTY' } };
  }

  /** The payment links opened, by token, with the visits; what opening one comes to. */
  readonly links: { token: string; visits: StorefrontVisit[] }[] = [];
  link: PaymentLinkOpenResponse | Error = {
    path: '/checkouts/l-secret',
    url: 'http://core.test/checkouts/l-secret',
  };

  async openPaymentLink(
    _shopId: string,
    token: string,
    visits: StorefrontVisit[] = [],
  ): Promise<PaymentLinkOpenResponse> {
    this.links.push({ token, visits });
    if (this.link instanceof Error) throw this.link;
    return this.link;
  }

  async checkoutPage(
    _shopId: string,
    token: string,
    form: Record<string, string> | null,
    client?: CheckoutClient,
  ): Promise<CheckoutPageResponse> {
    this.pages.push({ token, form, ...(client && { client }) });
    if (this.page instanceof Error) throw this.page;
    return this.page;
  }

  /** The searches asked for, and what they find. */
  readonly searches: { shopId: string; terms: string; options: SearchOptions }[] = [];
  found: string[] | Error = [];

  async search(shopId: string, terms: string, options: SearchOptions = {}): Promise<string[]> {
    this.searches.push({ shopId, terms, options });
    if (this.found instanceof Error) throw this.found;
    return this.found.slice(0, options.limit);
  }

  /** The searches of the shop's pages and articles asked for, and what they find (ADR-212). */
  readonly contentSearches: { shopId: string; terms: string; options: ContentSearchOptions }[] = [];
  foundContent: ContentSearchResponse = { pageIds: [], articleIds: [] };

  async searchContent(
    shopId: string,
    terms: string,
    options: ContentSearchOptions = {},
  ): Promise<ContentSearchResponse> {
    this.contentSearches.push({ shopId, terms, options });
    const types = options.types ?? ['page', 'article'];
    return {
      pageIds: types.includes('page') ? this.foundContent.pageIds.slice(0, options.limit) : [],
      articleIds: types.includes('article')
        ? this.foundContent.articleIds.slice(0, options.limit)
        : [],
    };
  }

  /** Preview links' tokens, and the themes they show; the tokens asked about. */
  readonly previews = new Map<string, ThemePreviewResponse>();
  readonly previewsAsked: string[] = [];

  async themePreview(_shopId: string, token: string): Promise<ThemePreviewResponse | null> {
    this.previewsAsked.push(token);
    return this.previews.get(token) ?? null;
  }

  /** The sign-ups sent on, and how the core answers them. */
  readonly signUps: { shopId: string; request: SignUpRequest }[] = [];
  signedUp: SignUpResult | Error = { ok: true, created: true, subscribed: true };

  async signUp(shopId: string, request: SignUpRequest): Promise<SignUpResult> {
    this.signUps.push({ shopId, request });
    if (this.signedUp instanceof Error) throw this.signedUp;
    return this.signedUp;
  }

  /** The comments sent on, and how the core answers them (ADR-220). */
  readonly comments: { shopId: string; request: CommentRequest }[] = [];
  commented: CommentResult | Error = { ok: true, status: 'pending' };

  async postComment(shopId: string, request: CommentRequest): Promise<CommentResult> {
    this.comments.push({ shopId, request });
    if (this.commented instanceof Error) throw this.commented;
    return this.commented;
  }
}

/** A preview link's token, as the core seals them. */
const PREVIEW_TOKEN = 'v1.k1.cHJldmlldy1pdiE.c2VhbGVkLWNsYWltcy1hbmQtdGFn';

/** A theme a preview link shows for the next hour, its home page a banner with `heading`. */
const previewing = (name: string, heading: string): ThemePreviewResponse => ({
  theme: {
    id: 'thm-9',
    name,
    version: 3,
    base: 'hatti-base',
    files: { 'templates/index.json': bannerHome(heading) },
  },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

describe('Carts', () => {
  const sample = sampleStore();
  const lawn = sample.products[0]!;
  const variant = lawn.variants[1]!;
  const line = (quantity: number) => ({
    key: `${variant.id}:0123456789abcdef0123456789abcdef`,
    variantId: variant.id,
    productId: lawn.id,
    quantity,
    properties: {},
    price: variant.price,
    linePrice: variant.price * quantity,
    title: lawn.title,
    variantTitle: variant.title,
    sku: variant.sku,
    grams: 0,
    taxable: true,
    taxCode: null,
    maxQuantity: null,
  });
  const cartOf = (quantity: number, note = ''): CartJson => ({
    note,
    attributes: {},
    items: quantity > 0 ? [line(quantity)] : [],
    itemCount: quantity,
    subtotal: variant.price * quantity,
    totalWeightGrams: 0,
    discount: null,
    totalDiscount: 0,
  });
  let theme: Theme;
  let core: FakeCore;

  beforeAll(async () => {
    theme = loadTheme(await readThemeDir(THEME_DIR));
  });

  const server = (extra: Partial<StorefrontServerOptions> = {}) => {
    core = new FakeCore();
    return createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      sample: new MemoryStore(sampleStore()),
      core,
      ...extra,
    });
  };
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const FORM = { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded' };

  it("adds to the cart from a product page's form, keeping the cart's secret in a cookie", async () => {
    const app = server();
    core.answer = () => ({ ok: true, cart: cartOf(2), token: 'secret-1', added: [line(2).key] });
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add',
      headers: FORM,
      payload: form({
        form_type: 'product',
        id: variant.id,
        quantity: '2',
        'properties[Name]': 'Ayesha',
      }),
    });
    expect([added.statusCode, added.headers.location]).toEqual([303, '/cart']);
    expect(added.headers['set-cookie']).toEqual([
      'cart=secret-1; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly',
      'cart_count=2; Max-Age=1209600; Path=/; SameSite=Lax',
    ]);
    expect(added.headers['cache-control']).toBe('private, no-store');
    expect(core.actions).toEqual([
      {
        token: null,
        action: 'add',
        body: { items: [{ variantId: variant.id, quantity: 2, properties: { Name: 'Ayesha' } }] },
      },
    ]);

    // The cart page shows it, and /cart.js gives it to scripts.
    const cookie = 'cart=secret-1; cart_count=2';
    const page = await app.inject({
      method: 'GET',
      url: '/cart',
      headers: { host: 'localhost', cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<span class="count" data-cart-count>2</span>');
    expect(page.body).toContain(`href="/products/${lawn.handle}?variant=${variant.id}"`);
    expect(page.body).toContain(
      '<button type="submit" name="checkout" class="button">Check out</button>',
    );
    const json = await app.inject({
      method: 'GET',
      url: '/cart.js',
      headers: { host: 'localhost', cookie },
    });
    expect(json.json()).toMatchObject({
      item_count: 2,
      total_price: variant.price * 2,
      currency: 'PKR',
      items: [
        {
          id: variant.id,
          key: line(2).key,
          quantity: 2,
          title: `${lawn.title} - ${variant.title}`,
          variant_title: variant.title,
          url: `/products/${lawn.handle}?variant=${variant.id}`,
          handle: lawn.handle,
          final_line_price: variant.price * 2,
          taxable: true,
        },
      ],
    });
    // Without a cookie, an empty cart, and nothing asked of the core.
    const empty = await app.inject({
      method: 'GET',
      url: '/cart.js',
      headers: { host: 'localhost' },
    });
    expect(empty.json()).toMatchObject({ item_count: 0, items: [] });
    expect(empty.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it("answers themes' scripts as Shopify's Ajax cart does", async () => {
    const app = server();
    core.answer = (action) => ({
      ok: true,
      cart: cartOf(action === 'add' ? 3 : 1, 'Gift'),
      token: 'secret-2',
      added: action === 'add' ? [line(3).key] : [],
    });
    const script = {
      host: 'localhost',
      cookie: 'cart=secret-2',
      'content-type': 'application/json',
    };
    // One item gives its line back; `items` gives a list.
    const one = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: script,
      payload: { id: variant.id, quantity: 1 },
    });
    expect(one.json()).toMatchObject({ key: line(3).key, quantity: 3, product_title: lawn.title });
    const many = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: script,
      payload: { items: [{ id: variant.id, quantity: 1 }] },
    });
    expect(many.json()).toMatchObject({ items: [{ key: line(3).key }] });
    // Scripts posting to the form's address get JSON too, as Dawn's do.
    const change = await app.inject({
      method: 'POST',
      url: '/cart/change',
      headers: { ...script, 'x-requested-with': 'XMLHttpRequest' },
      payload: { id: line(3).key, quantity: 1 },
    });
    expect(change.json()).toMatchObject({ item_count: 1, note: 'Gift' });
    await app.inject({
      method: 'POST',
      url: '/cart/update.js',
      headers: script,
      payload: { updates: { [variant.id]: 4 }, note: 'Gift', attributes: { Wrap: 'Red' } },
    });
    expect(core.actions.map(({ token, action, body }) => [token, action, body])).toEqual([
      ['secret-2', 'add', { items: [{ variantId: variant.id, quantity: 1, properties: {} }] }],
      ['secret-2', 'add', { items: [{ variantId: variant.id, quantity: 1, properties: {} }] }],
      ['secret-2', 'change', { line: { key: line(3).key }, quantity: 1 }],
      [
        'secret-2',
        'update',
        {
          updates: [{ line: { variantId: variant.id }, quantity: 4 }],
          note: 'Gift',
          attributes: { Wrap: 'Red' },
        },
      ],
    ]);
    await app.close();
  });

  it("renders the sections a cart change asks for, and a page's, with the shopper's cart", async () => {
    const app = server();
    core.answer = () => ({ ok: true, cart: cartOf(2), token: 'secret-3', added: [line(2).key] });
    // A drawer adds by form, asking for its sections as the page it is on renders them.
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: FORM,
      payload: form({
        id: variant.id,
        quantity: '2',
        sections: 'cart-drawer, header-group__header,nothing',
        sections_url: `/products/${lawn.handle}`,
      }),
    });
    expect(added.statusCode).toBe(200);
    const answer = added.json() as { key: string; sections: Record<string, string | null> };
    expect(answer.key).toBe(line(2).key);
    expect(Object.keys(answer.sections)).toEqual([
      'cart-drawer',
      'header-group__header',
      'nothing',
    ]);
    expect(answer.sections['cart-drawer']).toContain(`>${lawn.title}</a>`);
    expect(answer.sections['cart-drawer']).toContain(
      'value="2" min="0" inputmode="numeric" data-line="1"',
    );
    expect(answer.sections['header-group__header']).toContain('class="header"');
    expect(answer.sections.nothing).toBeNull();

    // As JSON, a list, rendered as part of the shop's page that asked: here in Urdu.
    core.answer = () => ({ ok: true, cart: cartOf(0), token: 'secret-3', added: [] });
    const changed = await app.inject({
      method: 'POST',
      url: '/cart/change.js',
      headers: {
        host: 'localhost',
        cookie: 'cart=secret-3',
        'content-type': 'application/json',
        referer: 'http://localhost/ur/collections/eid',
      },
      payload: { line: 1, quantity: 0, sections: ['cart-drawer'] },
    });
    expect(changed.json()).toMatchObject({ item_count: 0 });
    expect(changed.json().sections['cart-drawer']).toContain('آپ کا کارٹ خالی ہے۔');

    // A page's sections, with the cart its cookie names, and never kept.
    core.kept.set('secret-4', cartOf(3));
    const drawer = await app.inject({
      method: 'GET',
      url: '/?section_id=cart-drawer',
      headers: { host: 'localhost', cookie: 'cart=secret-4' },
    });
    expect(drawer.statusCode).toBe(200);
    expect(drawer.headers['cache-control']).toBe('private, no-store');
    expect(drawer.body).toMatch(/^<div id="hatti-section-cart-drawer"/);
    expect(drawer.body).toContain('value="3"');
    const several = await app.inject({
      method: 'GET',
      url: `/products/${lawn.handle}?sections=cart-drawer,main,nothing`,
      headers: { host: 'localhost' },
    });
    const sections = several.json() as Record<string, string | null>;
    expect(Object.keys(sections)).toEqual(['cart-drawer', 'main', 'nothing']);
    expect(sections['cart-drawer']).toContain('Your cart is empty.');
    expect(sections.main).toContain(`>${lawn.title}</h1>`);
    expect(sections.nothing).toBeNull();
    // The cart page's own, as a theme's cart page asks for them.
    const cartPage = await app.inject({
      method: 'GET',
      url: '/cart?section_id=main',
      headers: { host: 'localhost', cookie: 'cart=secret-4' },
    });
    expect(cartPage.body).toMatch(/^<div id="hatti-section-main"/);
    expect(cartPage.body).toContain('value="3"');

    // A cookie naming no cart goes; a section there is not is not found.
    const stale = await app.inject({
      method: 'GET',
      url: '/?section_id=cart-drawer',
      headers: { host: 'localhost', cookie: 'cart=gone; cart_count=2' },
    });
    expect(stale.headers['set-cookie']).toEqual([
      'cart=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly',
      'cart_count=; Max-Age=0; Path=/; SameSite=Lax',
    ]);
    const missing = await app.inject({
      method: 'GET',
      url: '/?section_id=nothing',
      headers: { host: 'localhost' },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("has the edge keep pages by what they show, search briefly, and never a shopper's cart", async () => {
    const app = server();
    const get = (url: string, host = 'localhost') =>
      app.inject({ method: 'GET', url, headers: { host } });
    const tagsOf = (response: { headers: Record<string, unknown> }) =>
      String(response.headers['cache-tag']).split(',');

    const home = await get('/');
    expect(home.headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800',
    );
    // The shop's, and the collections its sections show, by handle.
    expect(tagsOf(home)).toEqual([
      'hatti:sample',
      'hatti:sample:collection:eid-lawn',
      'hatti:sample:collection:khussa',
      'hatti:sample:collection:mens-kurta',
    ]);
    expect(tagsOf(await get(`/ur/products/${lawn.handle}`))).toEqual([
      'hatti:sample',
      `hatti:sample:product:${lawn.handle}`,
      'hatti:sample:collection:eid-lawn',
    ]);
    // A handle nothing has yet: forgotten once something takes it, or a redirect from its path.
    const missing = await get('/pages/size-guide');
    expect([missing.statusCode, tagsOf(missing)]).toEqual([
      404,
      ['hatti:sample', 'hatti:sample:page:size-guide', pathTag('sample', '/pages/size-guide')],
    ]);

    // Search results for a minute; the cart, never; theme assets, for a year.
    expect((await get('/search?q=lawn')).headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=60',
    );
    const cart = await get('/cart');
    expect([cart.headers['cache-control'], cart.headers['cache-tag']]).toEqual([
      'private, no-store',
      undefined,
    ]);
    expect((await get('/assets/v1/base.css')).headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect((await get('/', 'nobody.localhost')).headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it("updates the cart page's quantities and note, and removes a line by its link", async () => {
    const app = server();
    core.answer = () => ({
      ok: true,
      cart: cartOf(0, 'Call first'),
      token: 'secret-3',
      added: [],
    });
    const updated = await app.inject({
      method: 'POST',
      url: '/ur/cart',
      headers: { ...FORM, cookie: 'cart=secret-3' },
      payload: 'form_type=cart&updates%5B%5D=1&updates%5B%5D=0&note=Call+first&update=',
    });
    expect([updated.statusCode, updated.headers.location]).toEqual([303, '/ur/cart']);
    const removed = await app.inject({
      method: 'GET',
      url: `/cart/change?id=${encodeURIComponent(line(1).key)}&quantity=0`,
      headers: { host: 'localhost', cookie: 'cart=secret-3' },
    });
    expect(removed.statusCode).toBe(303);
    expect(core.actions.map(({ action, body }) => [action, body])).toEqual([
      [
        'update',
        {
          updates: [
            { line: { index: 1 }, quantity: 1 },
            { line: { index: 2 }, quantity: 0 },
          ],
          note: 'Call first',
        },
      ],
      ['change', { line: { key: line(1).key }, quantity: 0 }],
    ]);
    // Only removing is a link; adding takes a form.
    const add = await app.inject({
      method: 'GET',
      url: `/cart/add?id=${variant.id}`,
      headers: { host: 'localhost' },
    });
    expect(add.statusCode).toBe(405);
    await app.close();
  });

  it("says why a change was refused, in the page's language", async () => {
    const app = server();
    core.kept.set('secret-4', cartOf(2));
    core.answer = () => ({
      ok: false,
      error: { code: 'MAX_QUANTITY', variantId: variant.id, title: 'Rose Lawn', max: 3 },
    });
    const post = (url: string, headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url,
        headers: { ...FORM, cookie: 'cart=secret-4', ...headers },
        payload: form({ id: variant.id, quantity: '5' }),
      });
    const page = await post('/cart/add', {});
    expect(page.statusCode).toBe(422);
    expect(page.body).toContain(
      '<p class="cart__error" role="alert" dir="auto">You can have at most 3 of Rose Lawn in your cart.</p>',
    );
    // The cart as it was.
    expect(page.body).toContain('<span class="count" data-cart-count>2</span>');
    const urdu = await post('/ur/cart/add.js', {});
    expect([urdu.statusCode, urdu.json()]).toEqual([
      422,
      {
        status: 422,
        message: 'Cart Error',
        description: 'آپ کارٹ میں Rose Lawn زیادہ سے زیادہ 3 رکھ سکتے ہیں۔',
      },
    ]);
    core.answer = () => ({ ok: false, error: { code: 'NOT_FOUND', variantId: 'x' } });
    expect((await post('/cart/add.js', {})).json()).toEqual({
      status: 404,
      message: 'Cart Error',
      description: 'This product is no longer for sale.',
    });
    await app.close();
  });

  it('checks out from the cart form, its changes saved first, or from /checkout', async () => {
    const app = server();
    core.answer = () => ({ ok: true, cart: cartOf(2), token: 'secret-5', added: [] });
    const checkedOut = await app.inject({
      method: 'POST',
      url: '/cart',
      headers: { ...FORM, cookie: 'cart=secret-5' },
      payload: 'form_type=cart&updates%5B%5D=2&note=&checkout=',
    });
    expect([checkedOut.statusCode, checkedOut.headers.location]).toEqual([
      303,
      '/checkouts/c-secret',
    ]);
    expect(checkedOut.headers['set-cookie']).toContain(
      'cart=secret-5; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly',
    );
    expect(core.actions.map(({ action }) => action)).toEqual(['update']);
    expect(core.started).toEqual(['secret-5']);
    // Themes' checkout links and return_to go to /checkout.
    const linked = await app.inject({
      method: 'GET',
      url: '/checkout',
      headers: { host: 'localhost', cookie: 'cart=secret-5' },
    });
    expect([linked.statusCode, linked.headers.location]).toEqual([303, '/checkouts/c-secret']);
    expect(linked.headers['cache-control']).toBe('private, no-store');

    // Nothing to order: back to the cart, in the shopper's language.
    core.answer = () => ({ ok: true, cart: cartOf(0), token: 'secret-6', added: [] });
    const emptied = await app.inject({
      method: 'POST',
      url: '/ur/cart',
      headers: { ...FORM, cookie: 'cart=secret-6' },
      payload: 'updates%5B%5D=0&checkout=',
    });
    expect([emptied.statusCode, emptied.headers.location]).toEqual([303, '/ur/cart']);
    const none = await app.inject({
      method: 'GET',
      url: '/checkout',
      headers: { host: 'localhost' },
    });
    expect([none.statusCode, none.headers.location]).toEqual([303, '/cart']);
    expect(core.started).toEqual(['secret-5', 'secret-5', 'secret-6', null]);
    await app.close();
  });

  it("keeps a discount link's code with the shopper's cart, and sends them on, never off the shop", async () => {
    const app = server();
    const unusable = { code: 'EID10', applicable: false, kind: null, value: 0, amount: 0 };
    core.answer = () => ({
      ok: true,
      cart: { ...cartOf(0), discount: unusable },
      token: 'secret-8',
      added: [],
    });
    // From an Instagram post: another site, and no cart yet, so one begun for the code.
    const followed = await app.inject({
      method: 'GET',
      url: '/discount/EID10?redirect=/collections/lawn%3Fsort_by%3Dprice-ascending',
      headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' },
    });
    expect([followed.statusCode, followed.headers.location]).toEqual([
      302,
      '/collections/lawn?sort_by=price-ascending',
    ]);
    expect(followed.headers['cache-control']).toBe('private, no-store');
    expect(followed.headers['set-cookie']).toEqual([
      'cart=secret-8; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly',
      'cart_count=0; Max-Age=1209600; Path=/; SameSite=Lax',
    ]);
    expect(core.actions).toEqual([{ token: null, action: 'update', body: { discount: 'EID10' } }]);

    // Without a redirect, or with one off the shop: home, in the link's language.
    const link = (url: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', cookie: 'cart=secret-8' } });
    for (const away of [
      '//evil.example',
      '/%09/evil.example',
      '/%5Cevil.example',
      'https://evil.example/',
    ]) {
      expect((await link(`/discount/EID10?redirect=${away}`)).headers.location, away).toBe('/');
    }
    expect((await link('/ur/discount/EID10')).headers.location).toBe('/ur');
    // The link's campaign goes on with the shopper, for the page they land on to keep (ADR-139).
    const tagged = await link('/discount/EID10?utm_source=instagram&fbclid=F1&redirect=/?x=1');
    expect(tagged.headers.location).toBe('/?x=1&utm_source=instagram&fbclid=F1');
    expect(core.actions.at(-1)).toEqual({
      token: 'secret-8',
      action: 'update',
      body: { discount: 'EID10' },
    });
    // A form's return_to stays on the shop too.
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add',
      headers: { ...FORM, cookie: 'cart=secret-8' },
      payload: form({ id: variant.id, return_to: '/\t/evil.example' }),
    });
    expect(added.headers.location).toBe('/cart');

    // A link checker's HEAD request only learns where; with the core away, the shopper still goes.
    const asked = core.actions.length;
    const head = await app.inject({
      method: 'HEAD',
      url: '/discount/EID10',
      headers: { host: 'localhost' },
    });
    expect([head.statusCode, head.headers.location, core.actions.length]).toEqual([
      302,
      '/',
      asked,
    ]);
    core.answer = () => new StorefrontApiError(502, 'Bad gateway');
    const down = await link('/discount/EID10?redirect=/cart');
    expect([down.statusCode, down.headers.location, down.headers['set-cookie']]).toEqual([
      302,
      '/cart',
      undefined,
    ]);
    await app.close();
  });

  it('opens a payment link to a checkout of its own, or sends the page saying why not', async () => {
    const app = server();
    const opened = await app.inject({
      method: 'GET',
      url: '/pay/AbCdEfGhIjKlMnOpQrStUv?utm_source=instagram',
      headers: { host: 'localhost', cookie: 'cart=own-1', 'sec-fetch-site': 'cross-site' },
    });
    expect([opened.statusCode, opened.headers.location]).toEqual([303, '/checkouts/l-secret']);
    expect(opened.headers['cache-control']).toBe('private, no-store');
    // The link is where the shopper landed, which their checkout keeps (ADR-139).
    expect(core.links).toEqual([
      {
        token: 'AbCdEfGhIjKlMnOpQrStUv',
        visits: [
          {
            occurredAt: expect.any(String),
            landingPage: 'http://localhost/pay/AbCdEfGhIjKlMnOpQrStUv?utm_source=instagram',
            referrerUrl: null,
          },
        ],
      },
    ]);
    // Their own cart is left as it is.
    expect([core.actions, core.started]).toEqual([[], []]);

    // Closed: the core's page, as it is.
    core.link = {
      status: 410,
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
      html: '<p>This link no longer takes orders</p>',
    };
    const closed = await app.inject({
      method: 'GET',
      url: '/ur/pay/AbCdEfGhIjKlMnOpQrStUv',
      headers: { host: 'localhost' },
    });
    expect([closed.statusCode, closed.headers['x-robots-tag'], closed.body]).toEqual([
      410,
      'noindex',
      '<p>This link no longer takes orders</p>',
    ]);
    // A HEAD request opens nothing; with the core away, the shopper is told so.
    const head = await app.inject({
      method: 'HEAD',
      url: '/pay/AbCdEfGhIjKlMnOpQrStUv',
      headers: { host: 'localhost' },
    });
    expect([head.statusCode, head.headers.location, core.links.length]).toEqual([302, '/', 2]);
    core.link = new StorefrontApiError(503, 'down');
    const away = await app.inject({
      method: 'GET',
      url: '/pay/AbCdEfGhIjKlMnOpQrStUv',
      headers: { host: 'localhost' },
    });
    expect(away.statusCode).toBe(503);
    await app.close();
  });

  it("follows a cart permalink to a checkout of its own, leaving the shopper's cart as it is", async () => {
    const app = server();
    const plain = lawn.variants[0]!;
    core.kept.set('own-1', cartOf(1));
    core.answer = (action) => ({
      ok: true,
      cart: cartOf(3),
      token: 'linked-1',
      added: action === 'add' ? [line(3).key] : [],
    });
    // From a chat: another site, and the shopper has a cart of their own.
    const permalink =
      `/cart/${variant.id}:2,${plain.id}:1` +
      '?discount=EID10&note=From+WhatsApp&attributes%5BSource%5D=WhatsApp';
    const followed = await app.inject({
      method: 'GET',
      url: permalink,
      headers: { host: 'localhost', cookie: 'cart=own-1', 'sec-fetch-site': 'cross-site' },
    });
    expect([followed.statusCode, followed.headers.location]).toEqual([303, '/checkouts/c-secret']);
    expect(followed.headers['cache-control']).toBe('private, no-store');
    // The cart cookies are left as they are; the link is the shopper's first visit (ADR-139),
    // which their checkout keeps.
    const [visit] = core.visits.at(-1)!;
    expect(visit).toEqual({
      occurredAt: expect.any(String),
      landingPage: `http://localhost${permalink}`,
      referrerUrl: null,
    });
    expect(String(followed.headers['set-cookie'])).toMatch(
      /^hatti_visits=[\w-]+; Max-Age=2592000; Path=\/; SameSite=Lax$/,
    );
    expect(core.actions).toEqual([
      {
        token: null,
        action: 'add',
        body: {
          items: [
            { variantId: variant.id, quantity: 2, properties: {} },
            { variantId: plain.id, quantity: 1, properties: {} },
          ],
        },
      },
      {
        token: 'linked-1',
        action: 'update',
        body: { note: 'From WhatsApp', attributes: { Source: 'WhatsApp' }, discount: 'EID10' },
      },
    ]);
    expect(core.started).toEqual(['linked-1']);

    // Its order placed, the shopper's own cart still counts what it holds.
    core.page = { placed: true };
    const placed = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: { ...FORM, cookie: 'cart=own-1; cart_count=1', 'sec-fetch-site': 'same-origin' },
      payload: form({ shown: 'digest', name: 'Ayesha Khan', phone: '0300 1234567' }),
    });
    expect(placed.headers['set-cookie']).toBe(
      'cart_count=1; Max-Age=1209600; Path=/; SameSite=Lax',
    );

    // Without a query, the items alone; colons as some apps write them.
    const actions = core.actions.length;
    const encoded = await app.inject({
      method: 'GET',
      url: `/ur/cart/${variant.id}%3A1`,
      headers: { host: 'localhost' },
    });
    expect(encoded.headers.location).toBe('/checkouts/c-secret');
    expect(core.actions.slice(actions)).toEqual([
      {
        token: null,
        action: 'add',
        body: { items: [{ variantId: variant.id, quantity: 1, properties: {} }] },
      },
    ]);

    // Items that cannot be had: the shopper's own cart, saying why.
    core.answer = () => ({ ok: false, error: { code: 'NOT_FOUND', variantId: variant.id } });
    const gone = await app.inject({
      method: 'GET',
      url: `/cart/${variant.id}:1`,
      headers: { host: 'localhost', cookie: 'cart=own-1' },
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toContain('This product is no longer for sale.');
    expect(gone.body).toContain('<span class="count" data-cart-count>1</span>');
    // A HEAD request changes nothing; a path that names no items is no permalink.
    const asked = core.actions.length;
    const head = await app.inject({
      method: 'HEAD',
      url: `/cart/${variant.id}:1`,
      headers: { host: 'localhost' },
    });
    expect([head.statusCode, head.headers.location]).toEqual([302, '/cart']);
    const unnamed = await app.inject({
      method: 'GET',
      url: `/cart/${variant.id}`,
      headers: { host: 'localhost' },
    });
    expect([unnamed.statusCode, core.actions.length]).toEqual([404, asked]);
    await app.close();
  });

  it("gives scripts the cart's discount code as Shopify's Ajax cart does, and takes theirs", async () => {
    const app = server();
    const subtotal = variant.price * 2;
    const percent = { code: 'EID10', applicable: true, kind: 'percentage' as const, value: 10 };
    const discounted = (discount: CartJson['discount']): CartJson => ({
      ...cartOf(2),
      discount,
      totalDiscount: discount?.amount ?? 0,
    });
    core.answer = () => ({
      ok: true,
      cart: discounted({ ...percent, amount: subtotal / 10 }),
      token: 'secret-9',
      added: [],
    });
    const script = {
      host: 'localhost',
      cookie: 'cart=secret-9',
      'content-type': 'application/json',
    };
    const updated = await app.inject({
      method: 'POST',
      url: '/cart/update.js',
      headers: script,
      payload: { discount: 'EID10,FREESHIP' },
    });
    expect(core.actions.map(({ body }) => body)).toEqual([{ discount: 'EID10,FREESHIP' }]);
    expect(updated.json()).toMatchObject({
      original_total_price: subtotal,
      items_subtotal_price: subtotal,
      total_discount: subtotal / 10,
      total_price: subtotal - subtotal / 10,
      cart_level_discount_applications: [
        {
          type: 'discount_code',
          title: 'EID10',
          value: '10.0',
          value_type: 'percentage',
          allocation_method: 'across',
          target_selection: 'all',
          target_type: 'line_item',
          total_allocated_amount: subtotal / 10,
        },
      ],
      discount_codes: [{ code: 'EID10', applicable: true }],
    });

    // An amount off, in rupees as Shopify's are; free delivery and a code that does not apply
    // take nothing off the cart.
    const read = async (discount: CartJson['discount']) => {
      core.kept.set('secret-9', discounted(discount));
      return (await app.inject({ method: 'GET', url: '/cart.js', headers: script })).json();
    };
    const amount = { code: 'EID500', applicable: true, kind: 'fixed_amount' as const };
    expect(await read({ ...amount, value: 500_00, amount: 500_00 })).toMatchObject({
      total_price: subtotal - 500_00,
      cart_level_discount_applications: [{ value: '500.0', value_type: 'fixed_amount' }],
    });
    const free = { code: 'FREESHIP', applicable: true, kind: 'free_shipping' as const };
    for (const discount of [
      { ...free, value: 0, amount: 0 },
      { code: 'eid10', applicable: false, kind: null, value: 0, amount: 0 },
    ]) {
      expect(await read(discount)).toMatchObject({
        total_price: subtotal,
        total_discount: 0,
        cart_level_discount_applications: [],
        discount_codes: [{ code: discount.code, applicable: discount.applicable }],
      });
    }
    await app.close();
  });

  it("shows a checkout's page on the shop's address, and forgets the count once its order is placed", async () => {
    const app = server();
    core.page = {
      placed: false,
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'",
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'DENY',
      },
      html: '<p>Checkout · Zari</p>',
    };
    const page = await app.inject({
      method: 'GET',
      url: '/checkouts/c-secret',
      headers: { host: 'localhost', cookie: 'cart=secret-7; cart_count=2' },
    });
    expect([page.statusCode, page.body]).toEqual([200, '<p>Checkout · Zari</p>']);
    expect(page.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'",
      'x-frame-options': 'DENY',
    });
    expect(page.headers['set-cookie']).toBeUndefined();

    core.page = { placed: true };
    const placed = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: {
        ...FORM,
        cookie: 'cart=secret-7; cart_count=2',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Linux; Android 14)',
      },
      remoteAddress: '203.0.113.7',
      payload: form({ shown: 'digest', name: 'Ayesha Khan', phone: '0300 1234567' }),
    });
    expect([placed.statusCode, placed.headers.location]).toEqual([303, '/checkouts/c-secret']);
    expect(placed.headers['set-cookie']).toBe(
      'cart_count=0; Max-Age=1209600; Path=/; SameSite=Lax',
    );
    // With where the shopper placed it from, which the order keeps.
    expect(core.pages).toEqual([
      { token: 'c-secret', form: null },
      {
        token: 'c-secret',
        form: { shown: 'digest', name: 'Ayesha Khan', phone: '0300 1234567' },
        client: { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
      },
    ]);

    // With the IDs the shop's Meta pixel gave the browser, for the order's conversions (ADR-144).
    await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: {
        ...FORM,
        cookie: '_fbp=fb.1.1727856000000.1116446470; _fbc=fb.1.1727856000000.IwAR2x; _fbx=1',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Linux; Android 14)',
      },
      remoteAddress: '203.0.113.7',
      payload: form({ shown: 'digest' }),
    });
    expect(core.pages.pop()!.client).toEqual({
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      browserIds: { fbp: 'fb.1.1727856000000.1116446470', fbc: 'fb.1.1727856000000.IwAR2x' },
    });

    // Its number proved by a code: the browser keeps the proof the core gives, for /checkouts
    // alone, and sends it with its next orders, which need not ask again (ADR-199).
    core.page = { placed: true, proof: 'p-token-0123456789abcdef' };
    const proved = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: { ...FORM, 'sec-fetch-site': 'same-origin' },
      payload: form({ shown: 'digest', code: '123456' }),
    });
    expect(proved.headers['set-cookie']).toEqual([
      'cart_count=0; Max-Age=1209600; Path=/; SameSite=Lax',
      'hatti_proved=p-token-0123456789abcdef; Path=/checkouts; Max-Age=2592000; HttpOnly; SameSite=Lax',
    ]);
    await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: {
        ...FORM,
        cookie: 'cart_count=1; hatti_proved=p-token-0123456789abcdef',
        'sec-fetch-site': 'same-origin',
      },
      remoteAddress: '203.0.113.7',
      payload: form({ shown: 'digest' }),
    });
    expect(core.pages.pop()!.client).toMatchObject({ proof: 'p-token-0123456789abcdef' });
    core.pages.pop();

    // Paying the order online: on to the shop's gateway, as the core says (ADR-152).
    core.page = { placed: false, redirect: 'https://getsafepay.com/checkout/pay?beacon=track_1' };
    const pay = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: { ...FORM, 'sec-fetch-site': 'same-origin' },
      payload: form({ action: 'pay' }),
    });
    expect([pay.statusCode, pay.headers.location]).toEqual([
      303,
      'https://getsafepay.com/checkout/pay?beacon=track_1',
    ]);
    expect(pay.headers['referrer-policy']).toBe('no-referrer');
    expect(pay.headers['set-cookie']).toBeUndefined();
    expect(core.pages.pop()!.form).toEqual({ action: 'pay' });

    // Orders are placed from the shop's own pages; and the core may be away.
    const crossSite = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: { ...FORM, 'sec-fetch-site': 'cross-site' },
      payload: form({ shown: 'digest' }),
    });
    expect(crossSite.statusCode).toBe(403);
    expect(core.pages).toHaveLength(2);
    core.page = new StorefrontApiError(502, 'Bad gateway');
    const down = await app.inject({
      method: 'GET',
      url: '/checkouts/c-secret',
      headers: { host: 'localhost' },
    });
    expect([down.statusCode, down.headers['cache-control']]).toEqual([503, 'no-store']);
    await app.close();
  });

  it("finds the shop's pages and articles beside its products, as asked, and suggests them (ADR-212)", async () => {
    const app = server();
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
    const [product] = sampleStore().products;
    core.found = [product!.id];
    core.foundContent = { pageIds: ['pg-returns'], articleIds: ['art-eid'] };
    const found = await get('/search?q=eid');
    expect(found.statusCode).toBe(200);
    expect(found.body).toContain('3 results for “eid”');
    // Products, then pages, then articles, each said what it is.
    const grid = found.body.slice(found.body.indexOf('<ul class="grid" role="list">'));
    const order = [
      `/products/${product!.handle}`,
      '/pages/returns',
      '/blogs/news/eid-lawn-is-here',
    ].map((url) => grid.indexOf(`href="${url}`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(found.body).toMatch(
      /<p class="search__kind">Page<\/p>\s*<h2 dir="auto"><a href="\/pages\/returns">Returns and exchanges<\/a><\/h2>\s*<p dir="auto">Changed your mind\?/,
    );
    expect(found.body).toContain('<p class="search__kind">Article</p>');
    expect(core.contentSearches).toEqual([
      { shopId: 'sample', terms: 'eid', options: { prefix: 'none', types: ['page', 'article'] } },
    ]);
    // Shopify's `type` says which kinds: products alone, or articles alone.
    await get('/search?q=eid&type=product');
    expect([core.searches.length, core.contentSearches.length]).toEqual([2, 1]);
    const articles = await get('/search?q=eid&type=article');
    expect([core.searches.length, core.contentSearches.at(-1)!.options.types]).toEqual([
      2,
      ['article'],
    ]);
    expect(articles.body).toContain('1 result for “eid”');

    // Suggested as Shopify's predictive search gives them, when asked for.
    const json = await get(
      '/search/suggest.json?q=eid&resources%5Btype%5D=product,page,article&resources%5Blimit%5D=2',
    );
    const results = (json.json() as { resources: { results: Record<string, unknown[]> } }).resources
      .results;
    expect(Object.keys(results)).toEqual(['products', 'pages', 'articles']);
    expect(results.pages).toEqual([
      expect.objectContaining({
        id: 'pg-returns',
        title: 'Returns and exchanges',
        url: '/pages/returns',
      }),
    ]);
    expect(results.articles).toEqual([
      expect.objectContaining({
        id: 'art-eid',
        url: '/blogs/news/eid-lawn-is-here',
        author: 'Ayesha Khan',
        tags: ['Eid', 'Lawn'],
      }),
    ]);
    expect(core.contentSearches.at(-1)!.options).toEqual({
      prefix: 'last',
      limit: 2,
      types: ['page', 'article'],
    });
    // Shopify's default kinds leave articles out; products alone ask nothing of the rest.
    const asked = core.contentSearches.length;
    await get('/search/suggest.json?q=eid&resources%5Btype%5D=product');
    expect(core.contentSearches).toHaveLength(asked);
    const section = await get(
      '/search/suggest?q=eid&section_id=predictive-search&resources%5Btype%5D=product,page,article',
    );
    expect(section.body).toMatch(
      /<a href="\/pages\/returns" class="predictive-search__link" tabindex="-1">\s*<span class="predictive-search__title" dir="auto">Returns and exchanges<\/span>\s*<span class="predictive-search__kind">Page<\/span>/,
    );
    expect(section.body).toContain('href="/blogs/news/eid-lawn-is-here"');
    await app.close();
  });

  it("searches the shop through the core, and shows what it found in the theme's search page", async () => {
    const app = server();
    core.found = sampleStore()
      .products.slice(0, 3)
      .map((product) => product.id);
    const found = await app.inject({
      method: 'GET',
      url: '/search?q=+Eid+lawn++',
      headers: { host: 'localhost' },
    });
    expect(found.statusCode).toBe(200);
    expect(found.body).toContain('3 results for “Eid lawn”');
    expect(core.searches).toEqual([
      { shopId: 'sample', terms: 'Eid lawn', options: { prefix: 'none' } },
    ]);
    // In Urdu too; without words, nothing to ask the core.
    const urdu = await app.inject({
      method: 'GET',
      url: '/ur/search?q=lawn',
      headers: { host: 'localhost' },
    });
    expect(urdu.body).toContain('کے لیے 3 نتائج');
    const blank = await app.inject({
      method: 'GET',
      url: '/search?q=+',
      headers: { host: 'localhost' },
    });
    expect(blank.statusCode).toBe(200);
    expect(core.searches).toHaveLength(2);
    // As Shopify's forms ask: the last word may be cut short.
    await app.inject({
      method: 'GET',
      url: '/search?q=kame&options%5Bprefix%5D=last',
      headers: { host: 'localhost' },
    });
    expect(core.searches[2]!.options).toEqual({ prefix: 'last' });
    // What the core cannot answer is said as such.
    core.found = new StorefrontApiError(502, 'Bad gateway');
    const down = await app.inject({
      method: 'GET',
      url: '/search?q=lawn',
      headers: { host: 'localhost' },
    });
    expect([down.statusCode, down.body]).toEqual([
      503,
      'Search cannot be reached just now. Please try again in a minute.\n',
    ]);
    await app.close();
  });

  it("suggests products as a shopper types, as JSON or in the theme's section", async () => {
    const app = server();
    const products = sampleStore().products;
    core.found = products.slice(0, 12).map((product) => product.id);
    const suggest = (url: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost' } });

    // Shopify's JSON: products, and nothing yet of the other kinds asked for.
    const json = await suggest(
      '/search/suggest.json?q=lawn&resources%5Btype%5D=product,collection&resources%5Blimit%5D=2',
    );
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(json.headers['cache-control']).toBe('public, max-age=0, s-maxage=60');
    const { results } = (json.json() as { resources: { results: Record<string, unknown[]> } })
      .resources;
    expect(Object.keys(results)).toEqual(['products', 'collections']);
    expect(results.collections).toEqual([]);
    const [first] = results.products as Record<string, unknown>[];
    const doc = products[0]!;
    expect(results.products).toHaveLength(2);
    expect(first).toMatchObject({
      id: doc.id,
      title: doc.title,
      handle: doc.handle,
      url: `/products/${doc.handle}`,
      available: true,
      price: `${Math.min(...doc.variants.map((v) => v.price)) / 100}.00`,
    });
    // Twice as many asked of the core, for the sold out to go last; the last word cut short.
    expect(core.searches.at(-1)).toEqual({
      shopId: 'sample',
      terms: 'lawn',
      options: { prefix: 'last', limit: 4 },
    });

    // The theme's section, in the page's language.
    const section = await suggest('/ur/search/suggest?q=lawn&section_id=predictive-search');
    expect(section.statusCode).toBe(200);
    expect(section.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(section.body).toMatch(/^<div id="hatti-section-predictive-search"/);
    expect(section.body).toContain('“lawn” تلاش کریں');
    expect((section.body.match(/role="option"/g) ?? []).length).toBe(11);

    // A section the theme has not, or none; nothing typed asks the core nothing.
    expect((await suggest('/search/suggest?q=lawn&section_id=nothing')).statusCode).toBe(404);
    expect((await suggest('/search/suggest?q=lawn')).statusCode).toBe(404);
    const asked = core.searches.length;
    const blank = await suggest('/search/suggest.json?q=+');
    expect(blank.json()).toEqual({
      resources: { results: { queries: [], products: [], collections: [], pages: [] } },
    });
    expect(core.searches).toHaveLength(asked);

    // The core not there: said as such, as JSON to scripts.
    core.found = new StorefrontApiError(502, 'Bad gateway');
    const down = await suggest('/search/suggest.json?q=lawn');
    expect([down.statusCode, down.json()]).toEqual([
      503,
      {
        status: 503,
        message: 'Service Unavailable',
        description: 'Search cannot be reached just now. Please try again in a minute.',
      },
    ]);
    await app.close();
  });

  it('shows the theme a preview link names on every page until the link ends, and never keeps it', async () => {
    const app = server();
    core.previews.set(PREVIEW_TOKEN, previewing('Winter <look>', 'Winter Sale'));
    const kept = `hatti_preview=${PREVIEW_TOKEN}`;
    const get = (url: string, cookie?: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...(cookie && { cookie }) } });

    // The link: the theme, and a cookie that keeps it for the link's hour.
    const opened = await get(`/?preview=${PREVIEW_TOKEN}`);
    expect(opened.statusCode).toBe(200);
    expect(opened.body).toContain('Winter Sale');
    expect(opened.body).toContain('Preview: <strong>Winter &lt;look&gt;</strong>');
    expect(opened.headers['cache-control']).toBe('private, no-store');
    expect(opened.headers['x-robots-tag']).toBe('noindex');
    expect(opened.headers['cache-tag']).toBeUndefined();
    expect(opened.headers['set-cookie']).toMatch(
      new RegExp(`^${kept}; Max-Age=35\\d\\d; Path=/; SameSite=Lax; HttpOnly$`),
    );
    // The pages after it, in Urdu too, their sections and the search page: the cookie's theme.
    const urdu = await get('/ur/', kept);
    expect(urdu.body).toContain('Winter Sale');
    expect(urdu.body).toContain('پیش منظر بند کریں');
    expect(urdu.headers['set-cookie']).toBeUndefined();
    // Staff previewing are no shoppers: their visits are not kept (ADR-139).
    expect(urdu.body).not.toContain('data-hatti-visits');
    const section = await get('/?section_id=banner', kept);
    expect([section.statusCode, section.body]).toEqual([200, expect.stringContaining('Winter')]);
    expect((await get('/search', kept)).headers['cache-control']).toBe('private, no-store');
    // Without it, the shop's own theme, kept at the edge as ever.
    const live = await get('/');
    expect(live.body).not.toContain('Winter Sale');
    expect(live.body).not.toContain('hatti-preview-bar');
    expect(live.headers['cache-control']).toMatch(/^public/);
    // Its head keeps the shopper's visits, in their browser: the page is still everyone's.
    expect(live.body).toMatch(/<head>[^]*<script data-hatti-visits>[^]*hatti_visits=[^]*<\/head>/);

    // `?preview=` with nothing ends it; so does a link that shows nothing any more.
    const ended = await get('/?preview=', kept);
    expect(ended.body).not.toContain('Winter Sale');
    expect(ended.headers['set-cookie']).toMatch(/^hatti_preview=; Max-Age=0; Path=\//);
    core.previews.delete(PREVIEW_TOKEN);
    const over = await get('/', kept);
    expect([over.statusCode, over.body]).toEqual([200, expect.not.stringContaining('Winter')]);
    expect(over.headers['set-cookie']).toMatch(/^hatti_preview=; Max-Age=0/);
    // It sets a cookie, so it is not kept, though it is the page everyone sees.
    expect([over.headers['cache-control'], over.headers['cache-tag']]).toEqual([
      'private, no-store',
      undefined,
    ]);
    // What no core would have sealed is not sent to it.
    const asked = core.previewsAsked.length;
    expect((await get('/?preview=%3Cscript%3E')).statusCode).toBe(200);
    expect(core.previewsAsked).toHaveLength(asked);
    await app.close();
  });

  it("puts a preview in design mode in the theme editor's frame, and renders its unsaved settings", async () => {
    const EDITOR = 'https://admin.hatti.pk';
    const app = server({ editorOrigins: [EDITOR] });
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    const kept = `hatti_preview=${PREVIEW_TOKEN}`;
    const page = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/', headers: { host: 'localhost', ...headers } });

    // The link opened in the editor's frame: kept in the frame's own cookie.
    const linked = await app.inject({
      method: 'GET',
      url: `/?preview=${PREVIEW_TOKEN}`,
      headers: { host: 'localhost', 'sec-fetch-dest': 'iframe' },
    });
    expect(linked.headers['set-cookie']).toMatch(
      /; Path=\/; SameSite=None; Secure; Partitioned; HttpOnly$/,
    );
    // Framed, as the editor frames it: design mode, and no bar; the editor alone may frame it.
    const framed = await page({ cookie: kept, 'sec-fetch-dest': 'iframe' });
    expect(framed.body).toContain('data-hatti-editor-section=');
    expect(framed.body).toContain('window.Shopify.designMode = true');
    expect(framed.body).not.toContain('hatti-preview-bar');
    expect(framed.body).not.toContain('data-hatti-visits');
    expect(framed.headers['content-security-policy']).toBe(`frame-ancestors ${EDITOR}`);
    expect(framed.headers['cache-control']).toBe('private, no-store');
    // Opened on its own, or framed without a preview: no design mode.
    const opened = await page({ cookie: kept });
    expect(opened.body).toContain('hatti-preview-bar');
    expect(opened.body).not.toContain('data-hatti-editor');
    expect((await page({ 'sec-fetch-dest': 'iframe' })).body).not.toContain('data-hatti-editor');

    // Its script renders a section again with the editor's unsaved files over the theme's.
    const ask = (body: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/editor/sections',
        headers: {
          host: 'localhost',
          cookie: kept,
          'x-hatti-editor': '1',
          'sec-fetch-site': 'same-origin',
          ...headers,
        },
        payload: body as Record<string, unknown>,
      });
    const unsaved = { 'templates/index.json': bannerHome('Unsaved Eid') };
    const rendered = await ask({ page: '/?x=1', sections: ['banner'], files: unsaved });
    expect(rendered.statusCode).toBe(200);
    expect(rendered.headers['cache-control']).toBe('private, no-store');
    const answer = rendered.json() as { sections: Record<string, string>; problems: string[] };
    expect(answer.problems).toEqual([]);
    expect(answer.sections.banner).toMatch(
      /^<div id="hatti-section-banner" class="hatti-section section-image-banner" data-hatti-editor-section=/,
    );
    expect(answer.sections.banner).toContain('Unsaved Eid');
    // What the storefront cannot use is said, and the saved file stands.
    const broken = await ask({
      page: '/',
      sections: ['banner', 'nothing'],
      files: { 'templates/index.json': '{ not json', 'layout/theme.liquid': '<html>' },
    });
    const told = broken.json() as { sections: Record<string, string | null>; problems: string[] };
    expect(told.sections.banner).toContain('Winter Sale');
    expect(told.sections.nothing).toBeNull();
    expect(told.problems).toHaveLength(2);
    expect(told.problems.join(' ')).toMatch(
      /templates\/index\.json.*layout\/theme\.liquid|layout\/theme\.liquid.*templates\/index\.json/s,
    );

    // Only the editor's script asks: with its header, from the page, in a preview.
    const good = { page: '/', sections: ['banner'], files: unsaved };
    expect((await ask(good, { 'x-hatti-editor': '' })).statusCode).toBe(403);
    expect((await ask(good, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await ask(good, { cookie: '' })).statusCode).toBe(403);
    for (const bad of [
      { ...good, page: 'https://evil.pk/' },
      { ...good, sections: [] },
      { ...good, sections: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { ...good, sections: ['<script>'] },
      { ...good, files: { 'templates/index.json': 1 } },
    ]) {
      expect((await ask(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    await app.close();

    // Without an editor's origin, no preview is framed or rendered for one.
    const plain = server();
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    const alone = await plain.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'localhost', cookie: kept, 'sec-fetch-dest': 'iframe' },
    });
    expect(alone.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(alone.body).not.toContain('data-hatti-editor');
    const refused = await plain.inject({
      method: 'POST',
      url: '/editor/sections',
      headers: { host: 'localhost', cookie: kept, 'x-hatti-editor': '1' },
      payload: good,
    });
    expect(refused.statusCode).toBe(403);
    await plain.close();
  });

  it('tells crawlers what to fetch, and lists every product, collection, page, blog and article in sitemaps', async () => {
    const app = server();
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
    const sample = sampleStore();
    const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

    const robots = await get('/robots.txt');
    expect(robots.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(robots.headers['cache-control']).toBe('public, max-age=0, s-maxage=3600');
    for (const line of ['Disallow: /cart', 'Disallow: /ur/search', 'Disallow: /*?*preview=']) {
      expect(robots.body.split('\n')).toContain(line);
    }
    expect(robots.body).toMatch(/\nSitemap: http:\/\/localhost\/sitemap\.xml\n$/);

    const index = await get('/sitemap.xml');
    expect(index.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(locs(index.body)).toEqual([
      'http://localhost/sitemaps/products-1.xml',
      'http://localhost/sitemaps/collections-1.xml',
      'http://localhost/sitemaps/pages-1.xml',
      'http://localhost/sitemaps/blogs-1.xml',
      'http://localhost/sitemaps/articles-1.xml',
    ]);
    const products = (await get('/sitemaps/products-1.xml')).body;
    expect(locs(products)).toHaveLength(sample.products.length);
    // Each with its image, whole (ADR-236).
    const pictured = sample.products.find((product) => product.images.length > 0)!;
    const handle = pictured.handle;
    expect(products).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(products).toContain(
      `<url><loc>http://localhost/products/${handle}</loc>` +
        `<xhtml:link rel="alternate" hreflang="en" href="http://localhost/products/${handle}"/>` +
        `<xhtml:link rel="alternate" hreflang="ur" href="http://localhost/ur/products/${handle}"/>` +
        `<image:image><image:loc>http://localhost${pictured.images[0]!.src}</image:loc>` +
        '</image:image></url>',
    );
    expect(locs((await get('/sitemaps/collections-1.xml')).body)).toHaveLength(
      sample.collections.length,
    );
    // The pages', with the home page first, in Urdu at /ur; each page with when it was
    // published, as it has not changed since.
    const pages = (await get('/sitemaps/pages-1.xml')).body;
    expect(locs(pages)[0]).toBe('http://localhost/');
    expect(pages).toContain('hreflang="ur" href="http://localhost/ur"/>');
    expect(locs(pages)).toHaveLength(1 + sample.pages!.length);
    const published = sample.pages![0]!;
    expect(pages).toContain(
      `<loc>http://localhost/pages/${published.handle}</loc>` +
        `<lastmod>${published.publishedAt.replace(/\.\d+(?=Z$)/, '')}</lastmod>`,
    );
    // Blogs, and articles at their blog's address and theirs (ADR-177).
    expect(locs((await get('/sitemaps/blogs-1.xml')).body)).toEqual([
      'http://localhost/blogs/news',
    ]);
    expect(locs((await get('/sitemaps/articles-1.xml')).body)).toEqual([
      'http://localhost/blogs/news/eid-lawn-is-here',
      'http://localhost/blogs/news/how-to-measure',
      'http://localhost/blogs/news/winter-shawls',
    ]);
    for (const missing of ['/sitemaps/products-2.xml', '/sitemaps/blogs-2.xml', '/sitemaps/x']) {
      expect((await get(missing)).statusCode, missing).toBe(404);
    }
    await app.close();

    // When a product last changed, to the second, after its address.
    const changed = server({
      sample: new MemoryStore({
        ...sample,
        products: sample.products.map((product, at) =>
          at === 0 ? { ...product, updatedAt: '2026-10-06T09:41:12.345Z' } : product,
        ),
      }),
    });
    const dated = (
      await changed.inject({
        method: 'GET',
        url: '/sitemaps/products-1.xml',
        headers: { host: 'localhost' },
      })
    ).body;
    expect(dated).toContain(
      `<loc>http://localhost/products/${sample.products[0]!.handle}</loc>` +
        '<lastmod>2026-10-06T09:41:12Z</lastmod>',
    );
    await changed.close();

    // The shop's own rules: those for every crawler join the platform's, its groups follow.
    const ruled = server({
      sample: new MemoryStore({
        ...sample,
        shop: {
          ...sample.shop,
          robotsRules: [
            '# The sale is not ready',
            'Disallow: /collections/sale',
            '',
            'User-agent: GPTBot',
            'Disallow: /',
            'Sitemap: https://zari.pk/lookbook.xml',
          ].join('\n'),
        },
      }),
    });
    const text = (
      await ruled.inject({ method: 'GET', url: '/robots.txt', headers: { host: 'localhost' } })
    ).body;
    expect(text).toContain(
      'Disallow: /*?*sections=\n# The sale is not ready\nDisallow: /collections/sale\n\n' +
        'User-agent: GPTBot\nDisallow: /\n\n' +
        'Sitemap: http://localhost/sitemap.xml\nSitemap: https://zari.pk/lookbook.xml\n',
    );
    expect(text.startsWith('User-agent: *\n')).toBe(true);
    await ruled.close();
  });

  it("gives Google's and Meta's catalogs the shop's products, an item a variant", async () => {
    const app = server();
    const feed = await app.inject({
      method: 'GET',
      url: PRODUCT_FEED_PATH,
      headers: { host: 'localhost' },
    });
    // Kept at the edge as sitemaps are, and forgotten with the shop's document.
    expect([
      feed.statusCode,
      feed.headers['content-type'],
      feed.headers['cache-control'],
      feed.headers['cache-tag'],
    ]).toEqual([
      200,
      'application/xml; charset=utf-8',
      'public, max-age=0, s-maxage=3600',
      'hatti:sample',
    ]);
    expect([...feed.body.matchAll(/<item>/g)]).toHaveLength(
      sample.products.reduce((count, product) => count + product.variants.length, 0),
    );
    expect(feed.body).toContain(
      `<g:link>http://localhost/products/${lawn.handle}?variant=${variant.id}</g:link>`,
    );
    expect(feed.body.endsWith('</channel>\n</rss>\n')).toBe(true);
    const missing = await app.inject({
      method: 'GET',
      url: PRODUCT_FEED_PATH,
      headers: { host: 'nobody.localhost' },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("gives a blog's Atom feed at its address with .atom, kept at the edge as its page is (ADR-209)", async () => {
    const app = server();
    const get = (url: string, host = 'localhost') =>
      app.inject({ method: 'GET', url, headers: { host } });
    const feed = await get('/blogs/news.atom');
    // Forgotten with the shop's document and the blog's, which an article's change purges.
    expect([
      feed.statusCode,
      feed.headers['content-type'],
      feed.headers['cache-control'],
      feed.headers['cache-tag'],
    ]).toEqual([
      200,
      'application/atom+xml; charset=utf-8',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800',
      'hatti:sample,hatti:sample:blog:news',
    ]);
    expect(feed.body).toContain('<title>Zari Fashions - News</title>');
    expect(feed.body).toContain(
      '<link rel="self" type="application/atom+xml" href="http://localhost/blogs/news.atom"/>',
    );
    expect(
      [...feed.body.matchAll(/<link rel="alternate" type="text\/html" href="([^"]+)"/g)].map(
        (m) => m[1],
      ),
    ).toEqual([
      'http://localhost/blogs/news',
      'http://localhost/blogs/news/eid-lawn-is-here',
      'http://localhost/blogs/news/how-to-measure',
      'http://localhost/blogs/news/winter-shawls',
    ]);
    expect(feed.body.endsWith('</entry>\n</feed>\n')).toBe(true);
    // No such blog, no such handle, and no such shop.
    for (const [url, host] of [
      ['/blogs/journal.atom', 'localhost'],
      ['/blogs/news.notes.atom', 'localhost'],
      ['/blogs/news.atom', 'nobody.localhost'],
    ] as const) {
      expect((await get(url, host)).statusCode, url).toBe(404);
    }
    // The blog's page is still its page.
    expect((await get('/blogs/news')).headers['content-type']).toBe('text/html; charset=utf-8');
    await app.close();
  });

  it("gives a collection's Atom feed at its address with .atom, forgotten with it or any product (ADR-216)", async () => {
    const app = server();
    const get = (url: string, host = 'localhost') =>
      app.inject({ method: 'GET', url, headers: { host } });
    const feed = await get('/collections/eid-lawn.atom');
    // Forgotten with the collection's document, and with any product's, which purges all's.
    expect([
      feed.statusCode,
      feed.headers['content-type'],
      feed.headers['cache-control'],
      feed.headers['cache-tag'],
    ]).toEqual([
      200,
      'application/atom+xml; charset=utf-8',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800',
      'hatti:sample,hatti:sample:collection:eid-lawn,hatti:sample:collection:all',
    ]);
    expect(feed.body).toContain(
      '<link rel="self" type="application/atom+xml" href="http://localhost/collections/eid-lawn.atom"/>',
    );
    const entries = [...feed.body.matchAll(/<entry>/g)].length;
    expect(entries).toBeGreaterThan(0);
    expect(entries).toBeLessThanOrEqual(50);
    expect(feed.body.endsWith('</entry>\n</feed>\n')).toBe(true);
    const all = await get('/collections/all.atom');
    expect([all.statusCode, all.headers['cache-tag']]).toEqual([
      200,
      'hatti:sample,hatti:sample:collection:all',
    ]);
    // No such collection, no such handle, and no such shop.
    for (const [url, host] of [
      ['/collections/silk.atom', 'localhost'],
      ['/collections/eid-lawn.x.atom', 'localhost'],
      ['/collections/eid-lawn.atom', 'nobody.localhost'],
    ] as const) {
      expect((await get(url, host)).statusCode, url).toBe(404);
    }
    // The collection's page is still its page, and links its feed.
    const page = await get('/collections/eid-lawn');
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toMatch(
      /<link rel="alternate" type="application\/atom\+xml" title="Zari Fashions - [^"]+" href="\/collections\/eid-lawn\.atom">/,
    );
    await app.close();
  });

  it("shows the shop's policies at Shopify's addresses, in its theme, and links them from the footer", async () => {
    const sample = sampleStore();
    const app = server({
      sample: new MemoryStore({
        ...sample,
        shop: { ...sample.shop, policies: ['refund_policy', 'shipping_policy'] },
        policies: {
          refund_policy: '<p>7 days.</p>',
          shipping_policy: '<p>Rs 250.</p>',
          // In Urdu, as the shop wrote it (ADR-239).
          'ur:refund_policy': '<p>سات دن۔</p>',
        },
      }),
    });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });

    const refund = await get('/policies/refund-policy');
    expect(refund.statusCode).toBe(200);
    expect(refund.body).toContain(
      '<div class="shopify-policy__container"><div class="shopify-policy__title">' +
        '<h1>Refund policy</h1></div><div class="shopify-policy__body">' +
        '<div class="rte" dir="auto"><p>7 days.</p></div></div></div>',
    );
    expect(refund.body).toMatch(/<title>Refund policy · /);
    expect(refund.headers['cache-control']).toMatch(/^public/);
    const urdu = await get('/ur/policies/refund-policy');
    expect(urdu.body).toContain('<h1>واپسی کی پالیسی</h1>');
    expect(urdu.body).toContain('dir="rtl"');
    // Its Urdu where the shop gave it, else its own words.
    expect(urdu.body).toContain('<div class="rte" dir="auto"><p>سات دن۔</p></div>');
    expect(refund.body).not.toContain('سات دن');
    expect((await get('/ur/policies/shipping-policy')).body).toContain('<p>Rs 250.</p>');
    // One the shop has not set, or none by the name, is not found.
    expect((await get('/policies/privacy-policy')).statusCode).toBe(404);
    expect((await get('/policies/returns')).statusCode).toBe(404);

    // Every page's footer lists them, in Shopify's order, in the page's language.
    const home = (await get('/')).body;
    expect(home).toContain(
      '<ul class="footer__policies" role="list"><li><a href="/policies/refund-policy">Refund policy</a>' +
        '</li><li><a href="/policies/shipping-policy">Shipping policy</a></li></ul>',
    );
    expect((await get('/ur')).body).toContain(
      'href="/ur/policies/shipping-policy">ترسیل کی پالیسی<',
    );
    await app.close();
  });

  it("shows the shop's link page at /links, in its theme, a product with nothing to choose a tap from checkout (ADR-161)", async () => {
    const sample = sampleStore();
    const [several, one, out] = sample.products as [ProductDoc, ProductDoc, ProductDoc];
    const single: ProductDoc = {
      ...one,
      variants: [{ ...one.variants[0]!, available: true, price: 250_000, compareAtPrice: 300_000 }],
    };
    const soldOut: ProductDoc = {
      ...out,
      variants: out.variants.map((variant) => ({ ...variant, available: false })),
    };
    const app = server({
      sample: new MemoryStore({
        ...sample,
        products: sample.products.map((product) =>
          product.id === single.id ? single : product.id === soldOut.id ? soldOut : product,
        ),
        shop: {
          ...sample.shop,
          linkPage: {
            bio: 'Lawn & khussas <handmade>.\nCash on delivery.',
            links: [
              { title: 'Eid sale', url: '/collections/eid-lawn' },
              { title: 'Instagram', url: 'https://www.instagram.com/zari.pk' },
            ],
            // One no longer on sale is left out.
            productIds: [single.id, 'p-gone', several.id, soldOut.id],
          },
        },
      }),
    });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
    // Its links go through the storefront, to be counted (ADR-204).
    const [eid, instagram, whatsapp] = [
      linkKey('/collections/eid-lawn'),
      linkKey('https://www.instagram.com/zari.pk'),
      linkKey('https://wa.me/923001234567'),
    ];

    const page = await get('/links');
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/<title>Zari Fashions<\/title>/);
    expect(page.body).toContain(
      '<div class="hatti-links"><h1 class="hatti-links__name" dir="auto">Zari Fashions</h1>' +
        '<p class="hatti-links__bio" dir="auto">Lawn &amp; khussas &lt;handmade&gt;.\n' +
        'Cash on delivery.</p><ul class="hatti-links__links" role="list">' +
        '<li><a class="button button--secondary hatti-links__link" ' +
        `href="/links/to/${eid}" dir="auto">Eid sale</a></li>` +
        '<li><a class="button button--secondary hatti-links__link" ' +
        `href="/links/to/${instagram}" dir="auto">Instagram</a></li>` +
        '<li><a class="button button--secondary hatti-links__link" ' +
        `href="/links/to/${whatsapp}" dir="auto">Chat on WhatsApp</a></li></ul>`,
    );
    const items = [...page.body.matchAll(/<li class="hatti-links__product">(.*?)<\/li>/g)].map(
      (match) => match[1]!,
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toContain(`<a class="card__link" href="/products/${single.handle}">`);
    expect(items[0]).toContain(
      '<div class="price price--sale"><span class="visually-hidden">Sale price</span>' +
        '<span class="price__amount">Rs 2,500</span>' +
        '<span class="visually-hidden">Regular price</span>' +
        '<s class="price__compare">Rs 3,000</s></div>' +
        `<a class="button hatti-links__buy" href="/cart/${single.variants[0]!.id}:1">Buy now</a>`,
    );
    expect(items[1]).toContain(
      `<a class="button button--secondary hatti-links__buy" href="/products/${several.handle}">` +
        'Choose options</a>',
    );
    expect(items[2]).toContain('aria-disabled="true">Sold out</span>');
    expect(page.body).toContain(
      '<p class="hatti-links__all"><a href="/collections/all">See all products</a></p>',
    );
    // Kept at the edge until the shop or any of its products changes.
    expect(page.headers['cache-control']).toMatch(/^public/);
    expect(String(page.headers['cache-tag']).split(',')).toEqual(
      expect.arrayContaining(['hatti:sample', 'hatti:sample:collection:all']),
    );

    // In Urdu, its paths on the shop stay in Urdu.
    const urdu = await get('/ur/links');
    expect(urdu.body).toContain('dir="rtl"');
    expect(urdu.body).toContain(`href="/ur/links/to/${eid}"`);
    expect(urdu.body).toContain(`href="/ur/links/to/${instagram}"`);
    expect(urdu.body).toContain(`href="/ur/cart/${single.variants[0]!.id}:1">ابھی خریدیں</a>`);
    expect(urdu.body).toContain('<a href="/ur/collections/all">تمام مصنوعات دیکھیں</a>');

    // A shop that set none has its name, its WhatsApp, and its products.
    const plain = server();
    const bare = await plain.inject({
      method: 'GET',
      url: '/links',
      headers: { host: 'localhost' },
    });
    expect(bare.statusCode).toBe(200);
    expect(bare.body).toContain(`href="/links/to/${whatsapp}"`);
    expect(bare.body).not.toContain('hatti-links__products');
    await plain.close();
    await app.close();
  });

  it('shows a product of the link page with its variant chosen, a tap from checkout (ADR-206)', async () => {
    const sample = sampleStore();
    const several = sample.products.find((product) => product.variants.length > 1)!;
    const [first, second, ...rest] = several.variants;
    // Its own price, on sale, and its own image.
    const chosen = { ...second!, price: 525_000, compareAtPrice: 600_000, image: 1 };
    const image = { src: '/images/products/rose-suit.jpg', width: 0, height: 0, alt: 'Rose suit' };
    const item = async (variantIds: (string | null)[], available = true) => {
      const product: ProductDoc = {
        ...several,
        images: [several.images[0]!, image],
        variants: [first!, { ...chosen, available }, ...rest],
      };
      const app = server({
        sample: new MemoryStore({
          ...sample,
          products: sample.products.map((each) => (each.id === product.id ? product : each)),
          shop: {
            ...sample.shop,
            linkPage: { bio: '', links: [], productIds: [product.id], variantIds },
          },
        }),
      });
      const page = await app.inject({
        method: 'GET',
        url: '/links',
        headers: { host: 'localhost' },
      });
      await app.close();
      return page.body.match(/<li class="hatti-links__product">(.*?)<\/li>/)![1]!;
    };
    const shown = await item([chosen.id]);
    expect(shown).toContain(
      `<a class="card__link" href="/products/${several.handle}?variant=${chosen.id}">`,
    );
    expect(shown).toContain('src="/images/products/rose-suit.jpg');
    expect(shown).toContain(
      `</h2><p class="hatti-links__variant" dir="auto">${chosen.title}</p></a>`,
    );
    expect(shown).toContain(
      '<div class="price price--sale"><span class="visually-hidden">Sale price</span>' +
        '<span class="price__amount">Rs 5,250</span>' +
        '<span class="visually-hidden">Regular price</span>' +
        '<s class="price__compare">Rs 6,000</s></div>' +
        `<a class="button hatti-links__buy" href="/cart/${chosen.id}:1">Buy now</a>`,
    );
    // Sold out, it says so; a variant gone since is as none chosen.
    expect(await item([chosen.id], false)).toContain('aria-disabled="true">Sold out</span>');
    const gone = await item(['v-gone']);
    expect(gone).toContain(`<a class="card__link" href="/products/${several.handle}">`);
    expect(gone).toContain('Choose options</a>');
    expect(gone).not.toContain('hatti-links__variant');
  });

  it("shows the shop's square logo atop its link page, else its logo, else neither (ADR-205)", async () => {
    const sample = sampleStore();
    const logo = 'https://api.hatti.pk/logos/s1?v=0a1b2c3d';
    const square = 'https://api.hatti.pk/logos/s1/square?v=4e5f6a7b';
    const page = async (brand: ShopDoc['brand']) => {
      const app = server({
        sample: new MemoryStore({ ...sample, shop: { ...sample.shop, ...(brand && { brand }) } }),
      });
      const response = await app.inject({
        method: 'GET',
        url: '/links',
        headers: { host: 'localhost' },
      });
      await app.close();
      return response.body;
    };
    expect(await page({ logo, squareLogo: square })).toContain(
      '<div class="hatti-links"><img class="hatti-links__image hatti-links__image--square" ' +
        `src="${square}" alt="" width="96" height="96"><h1 class="hatti-links__name"`,
    );
    expect(await page({ logo, squareLogo: null })).toContain(
      '<div class="hatti-links"><img class="hatti-links__image" ' +
        `src="${logo}" alt="" width="96" height="96"><h1 class="hatti-links__name"`,
    );
    expect(await page(undefined)).toContain(
      '<div class="hatti-links"><h1 class="hatti-links__name"',
    );
  });

  it("sends a tap on the link page's links on to where it goes, in the page's language, never kept (ADR-204)", async () => {
    const sample = sampleStore();
    const app = server({
      sample: new MemoryStore({
        ...sample,
        shop: {
          ...sample.shop,
          linkPage: {
            bio: '',
            links: [
              { title: 'Eid sale', url: '/collections/eid-lawn' },
              { title: 'Instagram', url: 'https://www.instagram.com/zari.pk' },
            ],
            productIds: [],
          },
        },
      }),
    });
    const tap = async (url: string, host = 'localhost') => {
      const response = await app.inject({ method: 'GET', url, headers: { host } });
      return [response.statusCode, response.headers.location, response.headers['cache-control']];
    };
    const [eid, instagram, whatsapp] = [
      linkKey('/collections/eid-lawn'),
      linkKey('https://www.instagram.com/zari.pk'),
      linkKey('https://wa.me/923001234567'),
    ];
    expect(eid).toMatch(/^[0-9a-f]{12}$/);
    expect(await tap(`/links/to/${eid}`)).toEqual([
      302,
      '/collections/eid-lawn',
      'private, no-store',
    ]);
    expect(await tap(`/links/to/${instagram}`)).toEqual([
      302,
      'https://www.instagram.com/zari.pk',
      'private, no-store',
    ]);
    expect(await tap(`/links/to/${whatsapp}`)).toEqual([
      302,
      'https://wa.me/923001234567',
      'private, no-store',
    ]);
    // From the page in Urdu, the shop's own paths stay in Urdu.
    expect((await tap(`/ur/links/to/${eid}`))[1]).toBe('/ur/collections/eid-lawn');
    expect((await tap(`/ur/links/to/${instagram}`))[1]).toBe('https://www.instagram.com/zari.pk');
    // Only the shop's own links: any other key, as of a link since taken off, is back at the page.
    expect(await tap('/links/to/0123456789ab')).toEqual([302, '/links', 'private, no-store']);
    expect((await tap(`/ur/links/to/${linkKey('https://evil.example')}`))[1]).toBe('/ur/links');
    // No shop answers here.
    expect((await tap(`/links/to/${eid}`, 'nobody.localhost'))[0]).toBe(404);
    await app.close();
  });

  it('sends shoppers on from addresses the shop has no page at, where its redirects point', async () => {
    const EDITOR = 'https://admin.hatti.pk';
    const app = server({
      editorOrigins: [EDITOR],
      sample: new MemoryStore({
        ...sampleStore(),
        redirects: {
          '/products/old-lawn': `/products/${lawn.handle}`,
          '/collections/sale': '/',
          '/blogs/news/eid-edit': 'https://instagram.com/zari',
          '/pages/رابطہ': '/pages/contact',
          '/pages/contact-us': '/pages/رابطہ#form',
          // A page is there: it is shown, never hidden by a redirect.
          [`/products/${lawn.handle}`]: '/collections/all',
        },
      }),
    });
    const get = (url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...headers } });
    const answer = async (url: string) => {
      const response = await get(url);
      return [response.statusCode, response.headers.location];
    };

    const moved = await get('/products/old-lawn/?utm_source=facebook');
    expect([moved.statusCode, moved.headers.location]).toEqual([
      301,
      `/products/${lawn.handle}?utm_source=facebook`,
    ]);
    // Kept at the edge until the redirect changes, or a product takes the handle.
    expect(moved.headers['cache-control']).toMatch(/^public, max-age=0, s-maxage=300/);
    expect(String(moved.headers['cache-tag']).split(',')).toEqual([
      'hatti:sample',
      'hatti:sample:product:old-lawn',
      pathTag('sample', '/products/old-lawn'),
    ]);
    // However the link wrote the path; in Urdu, to the page in Urdu.
    expect(await answer('/PRODUCTS//Old-Lawn')).toEqual([301, `/products/${lawn.handle}`]);
    expect(await answer('/ur/products/old-lawn')).toEqual([301, `/ur/products/${lawn.handle}`]);
    expect(await answer('/ur/collections/sale?page=2')).toEqual([301, '/ur?page=2']);
    expect(await answer('/ur/blogs/news/eid-edit')).toEqual([301, 'https://instagram.com/zari']);
    expect(await answer('/pages/%D8%B1%D8%A7%D8%A8%D8%B7%DB%81')).toEqual([301, '/pages/contact']);
    expect(await answer('/pages/contact-us')).toEqual([
      301,
      '/pages/%D8%B1%D8%A7%D8%A8%D8%B7%DB%81#form',
    ]);
    expect(await answer(`/products/${lawn.handle}`)).toEqual([200, undefined]);
    expect(await answer('/blogs/news/other')).toEqual([404, undefined]);

    // In a preview, followed but not kept; in the editor's frame, the 404 page, to change it.
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    const cookie = `hatti_preview=${PREVIEW_TOKEN}`;
    const previewed = await get('/products/old-lawn', { cookie });
    expect([previewed.statusCode, previewed.headers['cache-control']]).toEqual([
      301,
      'private, no-store',
    ]);
    const framed = await get('/products/old-lawn', { cookie, 'sec-fetch-dest': 'iframe' });
    expect(framed.statusCode).toBe(404);
    expect(framed.body).toContain('data-hatti-editor-section=');
    await app.close();
  });

  it('shows a shop closed behind its password nothing but its password page, until a shopper gives it', async () => {
    const verifier = await passwordVerifier('eid-2026');
    const sample = sampleStore();
    const app = server({
      sample: new MemoryStore({
        ...sample,
        shop: { ...sample.shop, password: { verifier, message: '<p>Opening on Chand Raat.</p>' } },
      }),
    });
    const get = (url: string, cookie?: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...(cookie && { cookie }) } });

    // Pages send shoppers to the password page, in their language; scripts are told it is shut.
    const home = await get('/');
    expect([home.statusCode, home.headers.location, home.headers['cache-control']]).toEqual([
      302,
      '/password',
      'private, no-store',
    ]);
    expect((await get(`/ur/products/${lawn.handle}`)).headers.location).toBe('/ur/password');
    expect((await get('/sitemap.xml')).headers.location).toBe('/password');
    expect((await get(PRODUCT_FEED_PATH)).headers.location).toBe('/password');
    expect((await get('/cart.js')).statusCode).toBe(401);
    expect((await get('/?section_id=header')).statusCode).toBe(401);
    const robots = await get('/robots.txt');
    expect([robots.body, robots.headers['cache-control']]).toEqual([
      'User-agent: *\nDisallow: /\n',
      'private, no-store',
    ]);

    // The theme's password page, with what the shop says: never kept, nor indexed.
    const page = await get('/password');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<p>Opening on Chand Raat.</p>');
    expect(page.body).toContain('action="/password"');
    expect(page.body).not.toContain('aria-invalid');
    expect([page.headers['cache-control'], page.headers['x-robots-tag']]).toEqual([
      'private, no-store',
      'noindex',
    ]);
    expect(page.headers['cache-tag']).toBeUndefined();
    const urdu = await get('/ur/password');
    expect(urdu.body).toContain('action="/ur/password"');
    expect(urdu.body).toContain('یہ دکان جلد کھلے گی');

    // A wrong password is said to be; the right one lets the shopper in, with a pass.
    const post = (password: string, url = '/password') =>
      app.inject({
        method: 'POST',
        url,
        headers: FORM,
        payload: form({ form_type: 'storefront_password', password }),
      });
    const wrong = await post('eid-2025');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain('aria-invalid="true"');
    expect(wrong.body).toContain('That password is not right. Try again.');
    const right = await post(' eid-2026 ', '/ur/password');
    expect([right.statusCode, right.headers.location]).toEqual([303, '/ur']);
    expect(right.headers['set-cookie']).toMatch(
      /^storefront_digest=[\w-]{43}; Max-Age=2592000; Path=\/; SameSite=Lax; HttpOnly$/,
    );
    const pass = String(right.headers['set-cookie']).split(';')[0]!;
    const inside = await get('/', pass);
    expect(inside.statusCode).toBe(200);
    // The shop is still closed to everyone else: nothing of it is kept at the edge.
    expect([inside.headers['cache-control'], inside.headers['cache-tag']]).toEqual([
      'private, no-store',
      undefined,
    ]);
    expect((await get('/password', pass)).headers.location).toBe('/');
    expect((await get('/', 'storefront_digest=forged')).statusCode).toBe(302);

    // Its staff see it through a preview, the password page too, to design it.
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    const preview = `hatti_preview=${PREVIEW_TOKEN}`;
    expect(await get('/', preview)).toMatchObject({ statusCode: 200 });
    expect((await get('/password', preview)).statusCode).toBe(200);
    await app.close();

    // An open shop has no password page.
    const open = server();
    expect(
      (await open.inject({ method: 'GET', url: '/password', headers: { host: 'localhost' } }))
        .headers.location,
    ).toBe('/');
    await open.close();
  });

  it('refuses changes from other sites, forgets carts that are gone, and says when the core is not there', async () => {
    const app = server();
    const crossSite = await app.inject({
      method: 'POST',
      url: '/cart/clear',
      headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(core.actions).toEqual([]);

    // A cookie naming a cart the core no longer has: both cookies go.
    const stale = await app.inject({
      method: 'GET',
      url: '/cart',
      headers: { host: 'localhost', cookie: 'cart=expired; cart_count=4' },
    });
    expect(stale.body).toContain('Your cart is empty.');
    expect(stale.headers['set-cookie']).toEqual([
      'cart=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly',
      'cart_count=; Max-Age=0; Path=/; SameSite=Lax',
    ]);

    core.answer = () => new StorefrontApiError(502, 'Bad gateway');
    const down = await app.inject({
      method: 'POST',
      url: '/cart/clear.js',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: {},
    });
    expect([down.statusCode, down.json().status]).toEqual([503, 503]);
    core.answer = () => new TypeError('fetch failed');
    expect(
      (await app.inject({ method: 'POST', url: '/cart/clear', headers: { host: 'localhost' } }))
        .statusCode,
    ).toBe(503);
    await app.close();
  });
  it('sends a sign-up on to the core, then back to its page saying how it went', async () => {
    const app = server();
    const post = (
      fields: Record<string, string>,
      headers: Record<string, string> = {},
      url = '/contact',
    ) =>
      app.inject({ method: 'POST', url, headers: { ...FORM, ...headers }, payload: form(fields) });
    const consent = 'Send me news and offers from Zari Fashions on WhatsApp';
    const signUp = {
      form_type: 'customer',
      'contact[phone]': '0300-1234567',
      'contact[tags]': 'newsletter',
      'contact[consent]': consent,
      return_to: '/#newsletter',
    };
    const taken = await post(signUp);
    expect([taken.statusCode, taken.headers.location, taken.headers['cache-control']]).toEqual([
      303,
      '/?customer_posted=true#newsletter',
      'private, no-store',
    ]);
    expect(core.signUps.map((signedUp) => signedUp.request)).toEqual([
      { phone: '0300-1234567', tags: 'newsletter', consent },
    ]);

    // What was wrong goes back to the page the browser came from, by field.
    core.signedUp = { ok: false, errors: [{ field: 'phone', message: 'Phone is not a mobile' }] };
    const wrong = await post(
      { form_type: 'customer', 'contact[phone]': '123' },
      { referer: 'http://localhost/collections/eid-lawn?page=2&customer_posted=true' },
    );
    expect(wrong.headers.location).toBe('/collections/eid-lawn?page=2&customer_error=phone');
    // In Urdu, with no page of the shop's to go back to, to its home.
    core.signedUp = { ok: true, created: false, subscribed: false };
    const urdu = await post(
      { form_type: 'customer', 'contact[phone]': '0300-1234567' },
      { referer: 'https://elsewhere.example/' },
      '/ur/contact',
    );
    expect(urdu.headers.location).toBe('/ur?customer_posted=true');

    // Shopify's contact form is not one Hatti takes, nor a sign-up from another site.
    expect((await post({ form_type: 'contact', 'contact[body]': 'Hi' })).statusCode).toBe(404);
    expect((await post(signUp, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    core.signedUp = new StorefrontApiError(502, 'Bad gateway');
    expect((await post(signUp)).statusCode).toBe(503);
    expect(core.signUps).toHaveLength(4);
    await app.close();
  });

  it('sends a comment on to the core, then back to its article saying how it went (ADR-220)', async () => {
    const app = server();
    const post = (
      fields: Record<string, string>,
      headers: Record<string, string> = {},
      url = '/blogs/news/eid-lawn-is-here/comments',
    ) =>
      app.inject({ method: 'POST', url, headers: { ...FORM, ...headers }, payload: form(fields) });
    const comment = {
      form_type: 'new_comment',
      'comment[author]': 'Zara',
      'comment[email]': 'zara@example.pk',
      'comment[body]': 'Lovely lawn',
    };
    const taken = await post(comment, { 'user-agent': 'Mozilla/5.0' });
    expect([taken.statusCode, taken.headers.location, taken.headers['cache-control']]).toEqual([
      303,
      '/blogs/news/eid-lawn-is-here?comment_posted=true#comments',
      'private, no-store',
    ]);
    expect(core.comments.map((posted) => posted.request)).toEqual([
      {
        blog: 'news',
        article: 'eid-lawn-is-here',
        author: 'Zara',
        email: 'zara@example.pk',
        body: 'Lovely lawn',
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
      },
    ]);

    // What was wrong, by field, back on the article in the page's language.
    core.commented = {
      ok: false,
      errors: [
        { field: 'email', message: 'Email must be an email address' },
        { field: 'body', message: "Body can't be blank" },
      ],
    };
    const wrong = await post(comment, {}, '/ur/blogs/news/eid-lawn-is-here/comments');
    expect(wrong.headers.location).toBe(
      '/ur/blogs/news/eid-lawn-is-here?comment_error=email%2Cbody#comment_form',
    );

    // Only Shopify's comment form, from the shop itself.
    expect((await post({ ...comment, form_type: 'customer' })).statusCode).toBe(404);
    expect((await post(comment, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    core.commented = new StorefrontApiError(502, 'Bad gateway');
    expect((await post(comment)).statusCode).toBe(503);
    expect(core.comments).toHaveLength(3);
    await app.close();
  });
});

describe.skipIf(!redisUrl)('The storefront server', () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-sfs-${randomBytes(4).toString('hex')}`;
  const keys = new StorefrontKeys(prefix);
  const queue = new BuildQueue(redis, { keys });
  const directory = new ShopDirectory(redis, keys);
  const [zari, bazaar, gone] = [randomUUID(), randomUUID(), randomUUID()];
  let theme: Theme;

  /** Publishes a shop's documents as the core does, and names it in the directory. */
  const publish = async (shopId: string, handle: string, documents: StoreDocuments) => {
    await queue.add(shopId, ['sample']);
    await queue.drain(shopId, async ({ writer }) => {
      await writer.putShop({ ...documents.shop, handle });
      await writer.putProducts(documents.products);
      await writer.putCollections(documents.collections);
      await writer.putMenus(documents.menus);
    });
    await directory.set(shopId, handle);
  };

  beforeAll(async () => {
    theme = loadTheme(await readThemeDir(THEME_DIR));
    const sample = sampleStore();
    await publish(zari, 'zari', sample);
    await publish(bazaar, 'bazaar', {
      ...sample,
      shop: { ...sample.shop, name: 'Bazaar of Lahore' },
      products: sample.products.slice(0, 10),
    });
    await directory.set(gone, 'gone');
  });

  afterAll(async () => {
    const found = await redis.keys(`${prefix}:*`);
    if (found.length > 0) await redis.del(...found);
    redis.disconnect();
  });

  const server = (core?: FakeCore) => {
    const sample = sampleStore();
    return createStorefrontServer({
      theme,
      // Time enough for a first render, which parses the theme, on a busy runner.
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      redis,
      keys,
      sample: new MemoryStore({ ...sample, shop: { ...sample.shop, name: 'Sample' } }),
      core,
    });
  };

  it("counts a shopper's session, and its way to an order, as the page's script says (ADR-180)", async () => {
    const core = new FakeCore();
    const served = server(core);
    // From an address of its own: its cart's changes count against no other test's limit.
    const app = {
      inject: (request: InjectOptions) =>
        served.inject({ ...request, remoteAddress: '203.0.113.180' }),
      close: () => served.close(),
    };
    const activity = new StorefrontActivity(redis, keys);
    const today = localDay(new Date(), 'Asia/Karachi');
    const shopper = {
      host: 'zari.localhost',
      cookie: 'cart=secret-9; hatti_session=AbCdEfGhIjKlMnOpQrStUv',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) Chrome/129.0.0.0 Mobile Safari/537.36',
    };
    // A shopper's page carries the script that tells of it.
    const home = await app.inject({ method: 'GET', url: '/', headers: shopper });
    expect(home.body).toContain(`navigator.sendBeacon('/.hatti/visit')`);
    const seen = await app.inject({ method: 'POST', url: '/.hatti/visit', headers: shopper });
    expect([seen.statusCode, seen.headers['cache-control']]).toEqual([204, 'no-store']);
    // Nothing counted for a robot, without a session or for a session that is no ID.
    for (const headers of [
      { ...shopper, 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      { ...shopper, cookie: 'cart=secret-9' },
      { ...shopper, cookie: 'hatti_session=short' },
    ]) {
      const ignored = await app.inject({ method: 'POST', url: '/.hatti/visit', headers });
      expect(ignored.statusCode).toBe(204);
    }
    const nowhere = { ...shopper, host: 'nobody.localhost' };
    expect(
      (await app.inject({ method: 'POST', url: '/.hatti/visit', headers: nowhere })).statusCode,
    ).toBe(404);
    expect(await activity.counts(zari, today)).toEqual({
      sessions: 1,
      added_to_cart: 0,
      reached_checkout: 0,
      converted: 0,
    });
    expect(await activity.liveVisitors(zari)).toBe(1);

    // On its way to an order: added to its cart, at checkout, and placed.
    const empty: CartJson = {
      note: '',
      attributes: {},
      items: [],
      itemCount: 0,
      subtotal: 0,
      totalWeightGrams: 0,
      discount: null,
      totalDiscount: 0,
    };
    core.answer = () => ({ ok: true, cart: empty, token: 'secret-9', added: [] });
    const variantId = sampleStore().products[0]!.variants[0]!.id;
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: { ...shopper, 'content-type': 'application/json' },
      payload: { id: variantId, quantity: 1 },
    });
    expect(added.statusCode).toBe(200);
    core.page = { placed: false, status: 200, headers: {}, html: '<p>Checkout</p>' };
    await app.inject({ method: 'GET', url: '/checkouts/c-secret', headers: shopper });
    core.page = { placed: true };
    const placed = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: { ...shopper, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=Ayesha',
    });
    expect(placed.statusCode).toBe(303);
    expect(await activity.counts(zari, today)).toEqual({
      sessions: 1,
      added_to_cart: 1,
      reached_checkout: 1,
      converted: 1,
    });
    // Another shop's sessions are its own.
    expect((await activity.counts(bazaar, today)).sessions).toBe(0);
    await app.close();
  });

  it("counts each tap on a shop's link page's links, a day at a time, but not a robot's (ADR-204)", async () => {
    const app = server();
    const browser = 'Mozilla/5.0 (Linux; Android 10; K) Chrome/129.0.0.0 Mobile Safari/537.36';
    const tap = (url: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'GET',
        url,
        // From an address of its own: its taps count against no other test's limit.
        remoteAddress: '203.0.113.204',
        headers: { host: 'zari.localhost', 'user-agent': browser, ...headers },
      });
    const activity = new StorefrontActivity(redis, keys);
    const today = localDay(new Date(), 'Asia/Karachi');
    const chat = 'https://wa.me/923001234567';
    // Zari's page has its chat on WhatsApp, through the storefront.
    expect((await tap('/links')).body).toContain(`href="/links/to/${linkKey(chat)}"`);

    for (const url of [`/links/to/${linkKey(chat)}`, `/ur/links/to/${linkKey(chat)}`]) {
      const sent = await tap(url);
      expect([sent.statusCode, sent.headers.location]).toEqual([302, chat]);
    }
    // A robot is sent on uncounted, and a link not on the page is never counted.
    const robot = await tap(`/links/to/${linkKey(chat)}`, {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
    });
    expect(robot.headers.location).toBe(chat);
    // Nor a browser's prefetch, or a HEAD request, which are no taps.
    await tap(`/links/to/${linkKey(chat)}`, { 'sec-purpose': 'prefetch;prerender' });
    const head = await app.inject({
      method: 'HEAD',
      url: `/links/to/${linkKey(chat)}`,
      remoteAddress: '203.0.113.204',
      headers: { host: 'zari.localhost', 'user-agent': browser },
    });
    expect(head.statusCode).toBe(302);
    expect((await tap('/links/to/0123456789ab')).headers.location).toBe('/links');
    expect(await activity.linkTaps(zari, today)).toEqual({ [chat]: 2 });
    // Another shop's taps are its own, and the sample shop's are never counted.
    expect(await activity.linkTaps(bazaar, today)).toEqual({});
    expect((await tap(`/links/to/${linkKey(chat)}`, { host: 'localhost' })).statusCode).toBe(302);
    expect(await activity.linkTaps('sample', today)).toEqual({});
    await app.close();
  });

  it("serves each shop at its handle's subdomain, and the sample shop at the domain", async () => {
    const app = server();
    const page = (host: string, url = '/') => app.inject({ method: 'GET', url, headers: { host } });

    const home = await page('zari.localhost:4100');
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('<title>Zari Fashions</title>');
    expect((await page('bazaar.localhost')).body).toContain('<title>Bazaar of Lahore</title>');
    expect((await page('localhost:4100')).body).toContain('<title>Sample</title>');

    // A shop's pages are its own: Bazaar has 10 of Zari's 201 products.
    const product = sampleStore().products[20]!;
    expect((await page('zari.localhost', `/products/${product.handle}`)).statusCode).toBe(200);
    expect((await page('bazaar.localhost', `/products/${product.handle}`)).statusCode).toBe(404);
    expect((await page('zari.localhost', '/ur/')).body).toMatch(/<html lang="ur" dir="rtl">/);
    await app.close();
  });

  it("serves a shop at its own domains, and sends shoppers' pages on to its primary one", async () => {
    const mehr = randomUUID();
    const sample = sampleStore();
    const shop = {
      ...sample.shop,
      name: 'Mehr Crafts',
      handle: 'mehr',
      domain: 'www.mehr.pk',
      domains: ['www.mehr.pk', 'mehr.pk'],
    };
    await publish(mehr, 'mehr', { ...sample, shop });
    await directory.setDomains(mehr, shop.domains);
    const app = server();
    const get = (host: string, url = '/') => app.inject({ method: 'GET', url, headers: { host } });

    const home = await get('www.mehr.pk');
    expect([home.statusCode, home.body]).toEqual([200, expect.stringContaining('Mehr Crafts')]);
    // At its handle's subdomain or its other domain: the same page at the primary one.
    const product = sample.products[3]!;
    const moved = await get('mehr.localhost:4100', `/products/${product.handle}?variant=v1`);
    expect([moved.statusCode, moved.headers.location]).toEqual([
      301,
      `http://www.mehr.pk:4100/products/${product.handle}?variant=v1`,
    ]);
    expect((await get('MEHR.PK.', '/ur/collections/all?page=2')).headers.location).toBe(
      'http://www.mehr.pk/ur/collections/all?page=2',
    );
    // What changes carts, and scripts, answer where they are asked.
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: { host: 'mehr.pk', 'content-type': 'application/json' },
      payload: { id: product.variants[0]!.id, quantity: 1 },
    });
    expect(added.statusCode).not.toBe(301);
    expect((await get('www.mehr.pk.evil.pk')).statusCode).toBe(404);
    // A preview stays where its link opened it.
    const core = new FakeCore();
    core.previews.set(PREVIEW_TOKEN, previewing('Mehr Winter', 'Mehr Winter Sale'));
    const previews = server(core);
    const opened = await previews.inject({
      method: 'GET',
      url: `/?preview=${PREVIEW_TOKEN}`,
      headers: { host: 'mehr.localhost:4100' },
    });
    expect([opened.statusCode, opened.body]).toEqual([200, expect.stringContaining('Mehr Winter')]);
    await previews.close();

    // A domain let go no longer answers.
    await directory.setDomains(mehr, ['www.mehr.pk'], shop.domains);
    await app.close();
    const fresh = server();
    expect(
      (await fresh.inject({ method: 'GET', url: '/', headers: { host: 'mehr.pk' } })).statusCode,
    ).toBe(404);
    await fresh.close();
  });

  it("tells crawlers the shop's own address, and lists what Valkey has", async () => {
    const app = createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, {
        limits: { timeMs: 10_000 },
        platformUrl: 'https://hatti.pk',
      }),
      domain: 'localhost',
      redis,
      keys,
      secureCookies: true,
    });
    const get = (host: string, url: string) =>
      app.inject({ method: 'GET', url, headers: { host } });
    expect((await get('zari.localhost', '/robots.txt')).body).toContain(
      'Sitemap: https://zari.hatti.pk/sitemap.xml',
    );
    const products = (await get('zari.localhost', '/sitemaps/products-1.xml')).body;
    expect([...products.matchAll(/<url>/g)]).toHaveLength(sampleStore().products.length);
    expect(products).toContain('<loc>https://zari.hatti.pk/products/');
    // Bazaar has 10 products of its own.
    const bazaarProducts = (await get('bazaar.localhost', '/sitemaps/products-1.xml')).body;
    expect([...bazaarProducts.matchAll(/<url>/g)]).toHaveLength(10);
    // Their catalog feeds, at the shops' own addresses.
    const feed = (await get('zari.localhost', PRODUCT_FEED_PATH)).body;
    expect(feed).toContain('<g:link>https://zari.hatti.pk/products/');
    const variants = (products: ProductDoc[]) =>
      products.reduce((count, product) => count + product.variants.length, 0);
    expect([...feed.matchAll(/<item>/g)]).toHaveLength(variants(sampleStore().products));
    const bazaarFeed = (await get('bazaar.localhost', PRODUCT_FEED_PATH)).body;
    expect(bazaarFeed).toContain('<title>Bazaar of Lahore</title>');
    expect([...bazaarFeed.matchAll(/<item>/g)]).toHaveLength(
      variants(sampleStore().products.slice(0, 10)),
    );
    await app.close();
  });

  it("shows a shop's own theme, and its next version once published", async () => {
    const sana = randomUUID();
    const sample = sampleStore();
    const shop = { ...sample.shop, name: 'Sana Lawn', handle: 'sana' };
    await publish(sana, 'sana', { ...sample, shop });
    const publishTheme = async (version: number, heading: string) => {
      await queue.add(sana, ['shop']);
      await queue.drain(sana, async ({ writer }) => {
        await writer.putTheme({
          id: 'thm-1',
          version,
          base: 'hatti-base',
          files: { 'templates/index.json': bannerHome(heading) },
        });
        await writer.putShop({ ...shop, theme: { id: 'thm-1', version } });
      });
    };
    const app = server();
    const home = async (host: string) =>
      (await app.inject({ method: 'GET', url: '/', headers: { host } })).body;

    expect(await home('sana.localhost')).toContain('Eid Lawn &#39;26');
    await publishTheme(1, 'Sana Winter Sale');
    expect(await home('sana.localhost')).toContain('Sana Winter Sale');
    // Other shops keep theirs.
    expect(await home('zari.localhost')).toContain('Eid Lawn &#39;26');
    await publishTheme(2, 'Sana Spring Lawn');
    const page = await home('sana.localhost');
    expect(page).toContain('Sana Spring Lawn');
    expect(page).not.toContain('Sana Winter Sale');
    await app.close();
  });

  it('limits how fast an address can change carts', async () => {
    const core = new FakeCore();
    const empty = {
      note: '',
      attributes: {},
      items: [],
      itemCount: 0,
      subtotal: 0,
      totalWeightGrams: 0,
      discount: null,
      totalDiscount: 0,
    };
    core.answer = () => ({ ok: true, cart: empty, token: null, added: [] });
    const app = createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      redis,
      keys,
      core,
    });
    const clear = () =>
      app.inject({ method: 'POST', url: '/cart/clear', headers: { host: 'zari.localhost' } });
    for (let change = 0; change < 120; change += 1) expect((await clear()).statusCode).toBe(303);
    const refused = await clear();
    expect([refused.statusCode, refused.body]).toEqual([
      429,
      'Too many changes to the cart. Please wait a moment.\n',
    ]);
    expect(core.actions).toHaveLength(120);
    await app.close();
  });

  it('limits how often an address can search, suggestions among its searches', async () => {
    const core = new FakeCore();
    const app = createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      redis,
      keys,
      core,
    });
    const ask = (url: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'bazaar.localhost' } });
    for (let search = 0; search < 120; search += 1) {
      expect((await ask('/search/suggest.json?q=lawn')).statusCode).toBe(200);
      expect((await ask('/search?q=lawn')).statusCode).toBe(200);
    }
    const refused = await ask('/search/suggest.json?q=lawn');
    expect([refused.statusCode, refused.json()]).toMatchObject([
      429,
      { status: 429, message: 'Too Many Requests' },
    ]);
    const page = await ask('/search?q=lawn');
    expect([page.statusCode, page.body]).toEqual([
      429,
      'Too many searches. Please wait a moment.\n',
    ]);
    expect(core.searches).toHaveLength(240);
    await app.close();
  });

  it("limits how often an address can try a closed shop's password", async () => {
    const closed = randomUUID();
    const sample = sampleStore();
    const verifier = await passwordVerifier('eid-2026');
    await publish(closed, 'closed', {
      ...sample,
      shop: { ...sample.shop, password: { verifier, message: '' } },
    });
    const app = server();
    expect(
      (await app.inject({ method: 'GET', url: '/', headers: { host: 'closed.localhost' } })).headers
        .location,
    ).toBe('/password');
    const tries = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const answer = await app.inject({
        method: 'POST',
        url: '/password',
        headers: { host: 'closed.localhost', 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'form_type=storefront_password&password=guess',
      });
      tries.push(answer.statusCode);
    }
    expect(tries).toEqual([...Array<number>(10).fill(401), 429]);
    await app.close();
  });

  it('takes sign-ups on a closed shop, as its password page may ask for them', async () => {
    const closed = randomUUID();
    const sample = sampleStore();
    const verifier = await passwordVerifier('eid-2026');
    await publish(closed, 'shut', {
      ...sample,
      shop: { ...sample.shop, password: { verifier, message: '' } },
    });
    const core = new FakeCore();
    const app = server(core);
    const signUp = await app.inject({
      method: 'POST',
      url: '/contact',
      headers: { host: 'shut.localhost', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'form_type=customer&contact%5Bphone%5D=0300-1234567&return_to=%2Fpassword',
    });
    expect([signUp.statusCode, signUp.headers.location]).toEqual([
      303,
      '/password?customer_posted=true',
    ]);
    expect(core.signUps.map((signedUp) => signedUp.shopId)).toEqual([closed]);
    await app.close();
  });

  it('answers 404 where no shop is, or where its documents are missing', async () => {
    const app = server();
    for (const host of ['nobody.localhost', 'zari.example.com', 'gone.localhost']) {
      const response = await app.inject({ method: 'GET', url: '/', headers: { host } });
      expect(response.statusCode, host).toBe(404);
      expect(response.headers['content-type'], host).toMatch(/^text\/plain/);
    }
    await app.close();
  });
});
