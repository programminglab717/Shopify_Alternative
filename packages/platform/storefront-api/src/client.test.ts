import { describe, expect, it } from 'vitest';
import { StorefrontApiError, StorefrontApiClient, type CartJson } from './index.js';

const EMPTY: CartJson = {
  note: '',
  attributes: {},
  items: [],
  itemCount: 0,
  subtotal: 0,
  totalWeightGrams: 0,
  discount: null,
  totalDiscount: 0,
};

/** A client whose requests go to `answer`, which records them. */
function clientAnswering(answer: (request: Request) => Response) {
  const requests: Request[] = [];
  const client = new StorefrontApiClient({
    baseUrl: 'http://core.test',
    key: 'storefront-key',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return answer(request);
    },
  });
  return { client, requests };
}

describe('StorefrontApiClient', () => {
  it("reads a shopper's cart with the storefront key, and asks nothing without a token", async () => {
    const { client, requests } = clientAnswering(() => Response.json({ cart: EMPTY }));
    expect(await client.read('shop-1', null)).toBeNull();
    expect(requests).toEqual([]);
    expect(await client.read('shop-1', 'secret')).toEqual(EMPTY);
    const [request] = requests;
    expect([request!.method, request!.url]).toEqual([
      'GET',
      'http://core.test/storefront/shops/shop-1/cart',
    ]);
    expect(request!.headers.get('authorization')).toBe('Bearer storefront-key');
    expect(request!.headers.get('x-hatti-cart')).toBe('secret');
  });

  it('posts actions as JSON, and gives back the cart or why it was refused', async () => {
    const { client, requests } = clientAnswering((request) =>
      request.url.endsWith('/add')
        ? Response.json({ cart: EMPTY, token: 'new-secret', added: ['k'] })
        : Response.json({ error: { code: 'LINE_NOT_FOUND' } }, { status: 422 }),
    );
    const items = [{ variantId: 'v', quantity: 2 }];
    expect(await client.act('shop-1', null, 'add', { items })).toEqual({
      ok: true,
      cart: EMPTY,
      token: 'new-secret',
      added: ['k'],
    });
    expect(requests[0]!.headers.get('x-hatti-cart')).toBeNull();
    expect(await requests[0]!.json()).toEqual({ items });
    expect(await client.act('shop-1', 'secret', 'change', { line: { index: 3 } })).toEqual({
      ok: false,
      error: { code: 'LINE_NOT_FOUND' },
    });
  });

  it('starts a checkout for the cart, and none without one', async () => {
    const { client, requests } = clientAnswering((request) =>
      request.headers.get('x-hatti-cart') === 'secret'
        ? Response.json({ path: '/checkouts/c', url: 'http://core.test/checkouts/c' })
        : Response.json({ error: { code: 'EMPTY' } }, { status: 422 }),
    );
    expect(await client.startCheckout('shop-1', null)).toEqual({
      ok: false,
      error: { code: 'EMPTY' },
    });
    expect(requests).toEqual([]);
    expect(await client.startCheckout('shop-1', 'secret')).toEqual({
      ok: true,
      path: '/checkouts/c',
      url: 'http://core.test/checkouts/c',
    });
    expect([requests[0]!.method, requests[0]!.url]).toEqual([
      'POST',
      'http://core.test/storefront/shops/shop-1/checkouts',
    ]);
    expect(await requests[0]!.json()).toEqual({});
    expect(await client.startCheckout('shop-1', 'gone')).toEqual({
      ok: false,
      error: { code: 'EMPTY' },
    });
    // With the visits that brought the shopper, for the order to keep.
    const visit = {
      occurredAt: '2026-10-01T09:30:00.000Z',
      landingPage: 'https://zari.pk/products/lawn?utm_source=facebook',
      referrerUrl: 'https://l.facebook.com/',
    };
    await client.startCheckout('shop-1', 'secret', [visit]);
    expect(await requests[2]!.json()).toEqual({ visits: [visit] });
  });

  it("fetches the shop's tracking page, and posts what the shopper typed", async () => {
    const page = { status: 200, headers: { 'x-a': '1' }, html: '<h1>Track</h1>' };
    const { client, requests } = clientAnswering(() => Response.json(page));
    expect(await client.trackingPage('shop-1', null)).toEqual(page);
    const form = { reference: '#1001', phone: '0300 1234567' };
    expect(await client.trackingPage('shop-1', form)).toEqual(page);
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', 'http://core.test/storefront/shops/shop-1/tracking'],
      ['POST', 'http://core.test/storefront/shops/shop-1/tracking'],
    ]);
    expect(await requests[1]!.json()).toEqual(form);
    const { client: down } = clientAnswering(() => new Response('down', { status: 503 }));
    await expect(down.trackingPage('shop-1', null)).rejects.toThrow(StorefrontApiError);
  });

  it('opens a payment link, with the visits that brought the shopper', async () => {
    const closed = { status: 410, headers: { 'x-a': '1' }, html: '<p>Closed</p>' };
    const { client, requests } = clientAnswering((request) =>
      request.url.endsWith('/open-link')
        ? Response.json({ path: '/checkouts/c', url: 'http://core.test/checkouts/c' })
        : request.url.endsWith('/closed-link')
          ? Response.json(closed)
          : new Response('down', { status: 503 }),
    );
    const visit = {
      occurredAt: '2026-10-01T09:30:00.000Z',
      landingPage: 'https://zari.pk/pay/open-link',
      referrerUrl: 'https://l.instagram.com/',
    };
    expect(await client.openPaymentLink('shop-1', 'open-link', [visit])).toEqual({
      path: '/checkouts/c',
      url: 'http://core.test/checkouts/c',
    });
    expect([requests[0]!.method, requests[0]!.url]).toEqual([
      'POST',
      'http://core.test/storefront/shops/shop-1/payment-links/open-link',
    ]);
    expect(await requests[0]!.json()).toEqual({ visits: [visit] });
    expect(await client.openPaymentLink('shop-1', 'closed-link')).toEqual(closed);
    await expect(client.openPaymentLink('shop-1', 'down')).rejects.toThrow(StorefrontApiError);
  });

  it("fetches a checkout's page, and posts its form as JSON with where it came from", async () => {
    const page = { placed: false, status: 200, headers: { 'x-a': '1' }, html: '<p>Hi</p>' };
    const { client, requests } = clientAnswering((request) =>
      Response.json(request.method === 'GET' ? page : { placed: true }),
    );
    expect(await client.checkoutPage('shop-1', 'c-secret', null)).toEqual(page);
    expect(
      await client.checkoutPage(
        'shop-1',
        'c-secret',
        { name: 'Ayesha' },
        { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
      ),
    ).toEqual({ placed: true });
    await client.checkoutPage(
      'shop-1',
      'c-secret',
      { name: 'Ayesha' },
      {
        ip: '203.0.113.7',
        userAgent: null,
        browserIds: { fbp: 'fb.1.1727856000000.1116446470', fbc: 'fb.1.1727856000000.IwAR2x' },
      },
    );
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', 'http://core.test/storefront/shops/shop-1/checkouts/c-secret'],
      ['POST', 'http://core.test/storefront/shops/shop-1/checkouts/c-secret'],
      ['POST', 'http://core.test/storefront/shops/shop-1/checkouts/c-secret'],
    ]);
    expect(requests[0]!.headers.get('x-hatti-cart')).toBeNull();
    expect(await requests[1]!.json()).toEqual({ name: 'Ayesha' });
    // Where the shopper placed it from, which the order keeps.
    expect(requests[0]!.headers.get('x-hatti-client-ip')).toBeNull();
    expect([
      requests[1]!.headers.get('x-hatti-client-ip'),
      requests[1]!.headers.get('x-hatti-client-user-agent'),
      requests[1]!.headers.get('x-hatti-client-browser-ids'),
    ]).toEqual(['203.0.113.7', 'Mozilla/5.0 (Linux; Android 14)', null]);
    // And the IDs the shop's Meta pixel gave their browser, when it had any (ADR-144).
    expect([
      requests[2]!.headers.get('x-hatti-client-user-agent'),
      requests[2]!.headers.get('x-hatti-client-browser-ids'),
    ]).toEqual([null, 'fbp=fb.1.1727856000000.1116446470&fbc=fb.1.1727856000000.IwAR2x']);
  });

  it('searches the shop for what the shopper typed, as much of it as a search reads', async () => {
    const { client, requests } = clientAnswering(() => Response.json({ productIds: ['p2', 'p1'] }));
    expect(await client.search('shop-1', 'lawn & chiffon')).toEqual(['p2', 'p1']);
    await client.search('shop-1', 'x'.repeat(500));
    expect(requests.map((request) => [request.method, request.url.length])).toEqual([
      ['GET', 'http://core.test/storefront/shops/shop-1/search?q=lawn+%26+chiffon'.length],
      ['GET', 'http://core.test/storefront/shops/shop-1/search?q='.length + 200],
    ]);
    expect(requests[0]!.url).toBe(
      'http://core.test/storefront/shops/shop-1/search?q=lawn+%26+chiffon',
    );
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer storefront-key');
    // As a shopper types: the last word cut short, and a few products.
    await client.search('shop-1', 'kame', { prefix: 'last', limit: 4 });
    expect(requests[2]!.url).toBe(
      'http://core.test/storefront/shops/shop-1/search?q=kame&prefix=last&limit=4',
    );
  });

  it("fetches the theme a preview link shows, handing its token back, and nothing once it's over", async () => {
    const preview = {
      theme: { id: 't1', name: 'Eid', version: 3, base: 'hatti-base', files: {} },
      expiresAt: '2026-10-14T00:00:00.000Z',
    };
    const { client, requests } = clientAnswering((request) =>
      request.headers.get('x-hatti-preview') === 'good'
        ? Response.json(preview)
        : new Response('Not found', { status: 404 }),
    );
    expect(await client.themePreview('shop-1', 'good')).toEqual(preview);
    expect(await client.themePreview('shop-1', 'over')).toBeNull();
    expect([requests[0]!.method, requests[0]!.url]).toEqual([
      'GET',
      'http://core.test/storefront/shops/shop-1/theme-preview',
    ]);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer storefront-key');
  });

  it('throws when the core answers otherwise', async () => {
    const { client } = clientAnswering(() => new Response('Unauthorized', { status: 401 }));
    await expect(client.read('shop-1', 'secret')).rejects.toThrow(StorefrontApiError);
    await expect(client.act('shop-1', null, 'clear', {})).rejects.toThrow(
      "The core's storefront API answered 401: Unauthorized",
    );
    await expect(client.themePreview('shop-1', 'good')).rejects.toThrow(StorefrontApiError);
  });
});
