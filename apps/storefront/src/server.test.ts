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
  CartApiError,
  type CartActionName,
  type CartActionResult,
  type CartBodies,
  type CartJson,
} from '@hatti/storefront-api';
import { Redis } from 'ioredis';
import { Parser } from 'liquidjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleStore } from './fixtures.js';
import { PageRenderer } from './render.js';
import { createStorefrontServer, handleOf, ShopResolver, ShopThemes } from './server.js';
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
class FakeCarts {
  readonly actions: { token: string | null; action: CartActionName; body: unknown }[] = [];
  readonly kept = new Map<string, CartJson>();
  answer: (action: CartActionName) => CartActionResult | Error = () => new Error('No answer');

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
}

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
  let carts: FakeCarts;

  beforeAll(async () => {
    theme = loadTheme(await readThemeDir(THEME_DIR));
  });

  const server = () => {
    carts = new FakeCarts();
    return createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      sample: new MemoryStore(sampleStore()),
      carts,
    });
  };
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const FORM = { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded' };

  it("adds to the cart from a product page's form, keeping the cart's secret in a cookie", async () => {
    const app = server();
    carts.answer = () => ({ ok: true, cart: cartOf(2), token: 'secret-1', added: [line(2).key] });
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
    expect(carts.actions).toEqual([
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
    carts.answer = (action) => ({
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
    expect(carts.actions.map(({ token, action, body }) => [token, action, body])).toEqual([
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

  it("updates the cart page's quantities and note, and removes a line by its link", async () => {
    const app = server();
    carts.answer = () => ({
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
    expect(carts.actions.map(({ action, body }) => [action, body])).toEqual([
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
    carts.kept.set('secret-4', cartOf(2));
    carts.answer = () => ({
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
    carts.answer = () => ({ ok: false, error: { code: 'NOT_FOUND', variantId: 'x' } });
    expect((await post('/cart/add.js', {})).json()).toEqual({
      status: 404,
      message: 'Cart Error',
      description: 'This product is no longer for sale.',
    });
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
    expect(carts.actions).toEqual([]);

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

    carts.answer = () => new CartApiError(502, 'Bad gateway');
    const down = await app.inject({
      method: 'POST',
      url: '/cart/clear.js',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: {},
    });
    expect([down.statusCode, down.json().status]).toEqual([503, 503]);
    carts.answer = () => new TypeError('fetch failed');
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

  const server = () => {
    const sample = sampleStore();
    return createStorefrontServer({
      theme,
      // Time enough for a first render, which parses the theme, on a busy runner.
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      redis,
      keys,
      sample: new MemoryStore({ ...sample, shop: { ...sample.shop, name: 'Sample' } }),
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
    const carts = new FakeCarts();
    const empty = {
      note: '',
      attributes: {},
      items: [],
      itemCount: 0,
      subtotal: 0,
      totalWeightGrams: 0,
    };
    carts.answer = () => ({ ok: true, cart: empty, token: null, added: [] });
    const app = createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      redis,
      keys,
      carts,
    });
    const clear = () =>
      app.inject({ method: 'POST', url: '/cart/clear', headers: { host: 'zari.localhost' } });
    for (let change = 0; change < 120; change += 1) expect((await clear()).statusCode).toBe(303);
    const refused = await clear();
    expect([refused.statusCode, refused.body]).toEqual([
      429,
      'Too many changes to the cart. Please wait a moment.\n',
    ]);
    expect(carts.actions).toHaveLength(120);
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
