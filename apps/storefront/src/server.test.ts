import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BuildQueue,
  MemoryStore,
  ShopDirectory,
  StorefrontKeys,
  type ShopDoc,
  type StoreData,
  type StoreDocuments,
  type ThemeDoc,
} from '@hatti/storefront-data';
import {
  StorefrontApiError,
  type CartActionName,
  type CartActionResult,
  type CartBodies,
  type CartError,
  type CartJson,
  type CheckoutPageResponse,
  type SearchOptions,
  type ThemePreviewResponse,
} from '@hatti/storefront-api';
import { Redis } from 'ioredis';
import { Parser } from 'liquidjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleStore } from './fixtures.js';
import { PageRenderer } from './render.js';
import {
  createStorefrontServer,
  handleOf,
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
  /** The carts checkouts were started for, and the checkout pages asked for. */
  readonly started: (string | null)[] = [];
  readonly pages: { token: string; form: Record<string, string> | null }[] = [];
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
  ): Promise<{ ok: true; path: string; url: string } | { ok: false; error: CartError }> {
    this.started.push(token);
    const cart = token ? this.kept.get(token) : undefined;
    return cart && cart.itemCount > 0
      ? { ok: true, path: '/checkouts/c-secret', url: 'http://core.test/checkouts/c-secret' }
      : { ok: false, error: { code: 'EMPTY' } };
  }

  async checkoutPage(
    _shopId: string,
    token: string,
    form: Record<string, string> | null,
  ): Promise<CheckoutPageResponse> {
    this.pages.push({ token, form });
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

  /** Preview links' tokens, and the themes they show; the tokens asked about. */
  readonly previews = new Map<string, ThemePreviewResponse>();
  readonly previewsAsked: string[] = [];

  async themePreview(_shopId: string, token: string): Promise<ThemePreviewResponse | null> {
    this.previewsAsked.push(token);
    return this.previews.get(token) ?? null;
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
    maxQuantity: null,
  });
  const cartOf = (quantity: number, note = ''): CartJson => ({
    note,
    attributes: {},
    items: quantity > 0 ? [line(quantity)] : [],
    itemCount: quantity,
    subtotal: variant.price * quantity,
    totalWeightGrams: 0,
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
    // A handle nothing has yet: forgotten once something takes it.
    const missing = await get('/pages/size-guide');
    expect([missing.statusCode, tagsOf(missing)]).toEqual([
      404,
      ['hatti:sample', 'hatti:sample:page:size-guide'],
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
      headers: { ...FORM, cookie: 'cart=secret-7; cart_count=2', 'sec-fetch-site': 'same-origin' },
      payload: form({ shown: 'digest', name: 'Ayesha Khan', phone: '0300 1234567' }),
    });
    expect([placed.statusCode, placed.headers.location]).toEqual([303, '/checkouts/c-secret']);
    expect(placed.headers['set-cookie']).toBe(
      'cart_count=0; Max-Age=1209600; Path=/; SameSite=Lax',
    );
    expect(core.pages).toEqual([
      { token: 'c-secret', form: null },
      { token: 'c-secret', form: { shown: 'digest', name: 'Ayesha Khan', phone: '0300 1234567' } },
    ]);

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
    expect(found.body).toContain('3 products for “Eid lawn”');
    expect(core.searches).toEqual([
      { shopId: 'sample', terms: 'Eid lawn', options: { prefix: 'none' } },
    ]);
    // In Urdu too; without words, nothing to ask the core.
    const urdu = await app.inject({
      method: 'GET',
      url: '/ur/search?q=lawn',
      headers: { host: 'localhost' },
    });
    expect(urdu.body).toContain('کے لیے 3 پروڈکٹس');
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
    const section = await get('/?section_id=banner', kept);
    expect([section.statusCode, section.body]).toEqual([200, expect.stringContaining('Winter')]);
    expect((await get('/search', kept)).headers['cache-control']).toBe('private, no-store');
    // Without it, the shop's own theme, kept at the edge as ever.
    const live = await get('/');
    expect(live.body).not.toContain('Winter Sale');
    expect(live.body).not.toContain('hatti-preview-bar');
    expect(live.headers['cache-control']).toMatch(/^public/);

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

  it('tells crawlers what to fetch, and lists every product, collection and page in sitemaps', async () => {
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
    ]);
    const products = (await get('/sitemaps/products-1.xml')).body;
    expect(locs(products)).toHaveLength(sample.products.length);
    const handle = sample.products[0]!.handle;
    expect(products).toContain(
      `<url><loc>http://localhost/products/${handle}</loc>` +
        `<xhtml:link rel="alternate" hreflang="en" href="http://localhost/products/${handle}"/>` +
        `<xhtml:link rel="alternate" hreflang="ur" href="http://localhost/ur/products/${handle}"/></url>`,
    );
    expect(locs((await get('/sitemaps/collections-1.xml')).body)).toHaveLength(
      sample.collections.length,
    );
    // The pages', with the home page first, in Urdu at /ur.
    const pages = (await get('/sitemaps/pages-1.xml')).body;
    expect(locs(pages)[0]).toBe('http://localhost/');
    expect(pages).toContain('hreflang="ur" href="http://localhost/ur"/>');
    expect(locs(pages)).toHaveLength(1 + sample.pages!.length);
    for (const missing of ['/sitemaps/products-2.xml', '/sitemaps/blogs-1.xml', '/sitemaps/x']) {
      expect((await get(missing)).statusCode, missing).toBe(404);
    }
    await app.close();
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
