import { describe, expect, it } from 'vitest';
import {
  StorefrontApiError,
  StorefrontApiClient,
  accountCookie,
  accountCookieCleared,
  type AccountJson,
  type CartJson,
} from './index.js';

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

  it("posts a shopper's wish to hear a variant is back, and says what was wrong (ADR-429)", async () => {
    const wish = { variantId: 'var-1', phone: '0300 1234567', language: 'ur' as const };
    const { client, requests } = clientAnswering(() => Response.json({ created: true }));
    expect(await client.watchStock('shop-1', wish)).toEqual({ ok: true, created: true });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('http://core.test/storefront/shops/shop-1/stock-watches');
    expect(await requests[0]!.json()).toEqual(wish);
    const errors = [{ field: 'phone', message: 'Enter a Pakistani mobile number' }];
    const { client: refusing } = clientAnswering(() => Response.json({ errors }, { status: 422 }));
    expect(await refusing.watchStock('shop-1', wish)).toEqual({ ok: false, errors });
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

  it("fetches a picture a shop's theme shows, any of its pictures in a preview, and none it has not", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const { client, requests } = clientAnswering((request) =>
      request.url.includes('/file_known')
        ? new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
        : new Response('Not found', { status: 404 }),
    );
    expect(await client.themeImage('shop-1', 'file_known', false)).toEqual({
      body: jpeg,
      contentType: 'image/jpeg',
    });
    expect(await client.themeImage('shop-1', 'file_other', true)).toBeNull();
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', 'http://core.test/storefront/shops/shop-1/theme-images/file_known'],
      ['GET', 'http://core.test/storefront/shops/shop-1/theme-images/file_other?preview=1'],
    ]);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer storefront-key');
  });

  it('signs a shopper in with a code, from where they asked, and says what was wrong (ADR-570)', async () => {
    const session = {
      phone: '+923001234567',
      name: 'Ayesha Khan',
      signedInAt: '2026-10-18T09:00:00.000Z',
      expiresAt: '2026-11-17T09:00:00.000Z',
    };
    const { client, requests } = clientAnswering((request) => {
      if (request.url.endsWith('/login')) {
        return Response.json({ state: 'sent', phone: '0300 ••••567', channel: 'whatsapp' });
      }
      return Response.json({ token: 'session-secret', session });
    });
    expect(
      await client.accountLoginStart(
        'shop-1',
        { phone: '0300 1234567', locale: 'ur' },
        { ip: '203.0.113.7' },
      ),
    ).toEqual({ ok: true, state: 'sent', phone: '0300 ••••567', channel: 'whatsapp' });
    expect(
      await client.accountLoginVerify('shop-1', { phone: '0300 1234567', code: '048213' }),
    ).toEqual({ ok: true, token: 'session-secret', session });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['POST', 'http://core.test/storefront/shops/shop-1/account/login'],
      ['POST', 'http://core.test/storefront/shops/shop-1/account/login/verify'],
    ]);
    expect(await requests[0]!.json()).toEqual({ phone: '0300 1234567', locale: 'ur' });
    expect(requests[0]!.headers.get('x-hatti-client-ip')).toBe('203.0.113.7');
    expect(await requests[1]!.json()).toEqual({ phone: '0300 1234567', code: '048213' });

    const errors = [{ field: 'phone', message: 'Enter a Pakistani mobile number' }];
    const { client: refusing } = clientAnswering((request) =>
      request.url.endsWith('/login')
        ? Response.json({ errors }, { status: 422 })
        : Response.json({ error: 'wrong' }, { status: 422 }),
    );
    expect(await refusing.accountLoginStart('shop-1', { phone: '042' })).toEqual({
      ok: false,
      errors,
    });
    expect(
      await refusing.accountLoginVerify('shop-1', { phone: '0300 1234567', code: '1' }),
    ).toEqual({ ok: false, error: 'wrong' });
    // The cookie the storefront keeps it in, and takes away.
    expect(accountCookie('session-secret', { secure: true })).toBe(
      'hatti_account=session-secret; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax; Secure',
    );
    expect(accountCookieCleared({ secure: false })).toBe(
      'hatti_account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    );
  });

  it("reads a signed-in shopper's session and account, opens their order's page, and signs out", async () => {
    const account: AccountJson = {
      phone: '+923001234567',
      name: 'Ayesha Khan',
      orders: [
        {
          id: 'ord_1',
          name: '#1001',
          placedAt: '2026-10-01T09:00:00.000Z',
          status: 'open',
          financialStatus: 'pending',
          fulfillmentStatus: 'unfulfilled',
          total: 600_000,
          currency: 'PKR',
          itemCount: 3,
          hasPage: true,
          // What it sold, to buy again (ADR-574): as carts name variants, a bundle as itself.
          lines: [
            {
              variantId: '0192f3a4-7c4e-7d21-9a3b-5c6d7e8f9a01',
              productTitle: 'Lawn 3-piece',
              variantTitle: 'M',
              quantity: 2,
              available: true,
            },
            {
              variantId: null,
              productTitle: 'Eid 3-piece suit',
              variantTitle: null,
              quantity: 1,
              available: false,
            },
          ],
        },
      ],
      storeCredit: { balance: 50_000, currency: 'PKR', expiring: null },
      dataRequests: { available: true, erasureWaitDays: 10, export: null, erasure: null },
    };
    const link = { path: '/o/abc', url: 'http://core.test/o/abc' };
    const { client, requests } = clientAnswering((request) => {
      const signedIn = request.headers.get('x-hatti-account') === 'session-secret';
      if (request.url.endsWith('/logout')) return new Response(null, { status: 204 });
      if (request.url.endsWith('/session')) return Response.json({ session: null });
      if (request.url.endsWith('/link')) {
        return signedIn ? Response.json(link) : new Response('Not found', { status: 404 });
      }
      return Response.json({ account: signedIn ? account : null });
    });
    // Without a cookie, nothing is asked.
    expect(await client.account('shop-1', null)).toBeNull();
    expect(await client.accountSession('shop-1', null)).toBeNull();
    expect(await client.accountOrderLink('shop-1', null, 'ord_1')).toBeNull();
    await client.accountLogout('shop-1', null);
    expect(requests).toEqual([]);

    expect(await client.account('shop-1', 'session-secret')).toEqual(account);
    expect(await client.account('shop-1', 'gone')).toBeNull();
    expect(await client.accountSession('shop-1', 'gone')).toBeNull();
    expect(await client.accountOrderLink('shop-1', 'session-secret', 'ord_1')).toEqual(link);
    expect(await client.accountOrderLink('shop-1', 'gone', 'ord_1')).toBeNull();
    await client.accountLogout('shop-1', 'session-secret');
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', 'http://core.test/storefront/shops/shop-1/account'],
      ['GET', 'http://core.test/storefront/shops/shop-1/account'],
      ['GET', 'http://core.test/storefront/shops/shop-1/account/session'],
      ['POST', 'http://core.test/storefront/shops/shop-1/account/orders/ord_1/link'],
      ['POST', 'http://core.test/storefront/shops/shop-1/account/orders/ord_1/link'],
      ['POST', 'http://core.test/storefront/shops/shop-1/account/logout'],
    ]);
    // The session's secret goes in its header, never in the address.
    expect(requests[0]!.headers.get('x-hatti-account')).toBe('session-secret');
    expect(requests.every((request) => !request.url.includes('secret'))).toBe(true);
    const { client: down } = clientAnswering(() => new Response('down', { status: 503 }));
    await expect(down.account('shop-1', 'session-secret')).rejects.toThrow(StorefrontApiError);
    await expect(down.accountLogout('shop-1', 'session-secret')).rejects.toThrow(
      StorefrontApiError,
    );
  });

  it("asks for a signed-in shopper's own file and erasure (ADR-572)", async () => {
    const file = {
      state: 'ready',
      made: true,
      url: 'http://storage.test/customer-data/1.json?signed',
      readyAt: '2026-10-19T10:00:00.000Z',
      expiresAt: '2026-10-20T10:00:00.000Z',
    } as const;
    const erasure = {
      state: 'waiting',
      requestedAt: '2026-10-19T10:00:00.000Z',
      eraseAfter: '2026-10-29T10:00:00.000Z',
    } as const;
    const { client, requests } = clientAnswering((request) => {
      if (request.headers.get('x-hatti-account') !== 'session-secret') {
        return new Response('Not found', { status: 404 });
      }
      if (request.url.endsWith('/data/erase')) return Response.json(erasure);
      return Response.json(request.method === 'GET' ? { ...file, made: false } : file);
    });
    expect(await client.accountDataExport('shop-1', null)).toBeNull();
    expect(await client.accountDataExportLink('shop-1', null)).toBeNull();
    expect(await client.accountDataErase('shop-1', null)).toBeNull();
    expect(requests).toEqual([]);

    expect(await client.accountDataExport('shop-1', 'session-secret')).toEqual(file);
    expect(await client.accountDataExportLink('shop-1', 'session-secret')).toEqual({
      ...file,
      made: false,
    });
    expect(await client.accountDataErase('shop-1', 'session-secret')).toEqual(erasure);
    expect(await client.accountDataExport('shop-1', 'gone')).toBeNull();
    expect(await client.accountDataExportLink('shop-1', 'gone')).toBeNull();
    expect(await client.accountDataErase('shop-1', 'gone')).toBeNull();
    expect(requests.slice(0, 3).map((request) => [request.method, request.url])).toEqual([
      ['POST', 'http://core.test/storefront/shops/shop-1/account/data/export'],
      ['GET', 'http://core.test/storefront/shops/shop-1/account/data/export'],
      ['POST', 'http://core.test/storefront/shops/shop-1/account/data/erase'],
    ]);
    const { client: down } = clientAnswering(() => new Response('down', { status: 503 }));
    await expect(down.accountDataExport('shop-1', 'session-secret')).rejects.toThrow(
      StorefrontApiError,
    );
    await expect(down.accountDataErase('shop-1', 'session-secret')).rejects.toThrow(
      StorefrontApiError,
    );
  });

  it("reads, adds to and takes from a signed-in shopper's wishlist (ADR-575)", async () => {
    const kurta = '0190a1b2-0000-7000-8000-00000000000a';
    const shawl = '0190a1b2-0000-7000-8000-00000000000b';
    const { client, requests } = clientAnswering((request) => {
      if (request.headers.get('x-hatti-account') !== 'session-secret') {
        return new Response('Not found', { status: 404 });
      }
      if (request.method === 'DELETE') return Response.json({ productIds: [shawl] });
      return Response.json({ productIds: [kurta, shawl] });
    });
    expect(await client.accountWishlist('shop-1', null)).toBeNull();
    expect(await client.accountWishlistAdd('shop-1', null, [kurta])).toBeNull();
    expect(await client.accountWishlistRemove('shop-1', null, kurta)).toBeNull();
    expect(requests).toEqual([]);

    expect(await client.accountWishlist('shop-1', 'session-secret')).toEqual([kurta, shawl]);
    expect(await client.accountWishlistAdd('shop-1', 'session-secret', [kurta])).toEqual([
      kurta,
      shawl,
    ]);
    expect(await client.accountWishlistRemove('shop-1', 'session-secret', kurta)).toEqual([shawl]);
    expect(await client.accountWishlist('shop-1', 'gone')).toBeNull();
    expect(await client.accountWishlistAdd('shop-1', 'gone', [kurta])).toBeNull();
    expect(await client.accountWishlistRemove('shop-1', 'gone', kurta)).toBeNull();
    expect(requests.slice(0, 3).map((request) => [request.method, request.url])).toEqual([
      ['GET', 'http://core.test/storefront/shops/shop-1/account/wishlist'],
      ['POST', 'http://core.test/storefront/shops/shop-1/account/wishlist'],
      ['DELETE', `http://core.test/storefront/shops/shop-1/account/wishlist/${kurta}`],
    ]);
    expect(await requests[1]!.json()).toEqual({ productIds: [kurta] });
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer storefront-key');
    // An ID is one segment of the path, whatever it holds.
    await client.accountWishlistRemove('shop-1', 'session-secret', '../data/erase');
    expect(requests.at(-1)!.url).toBe(
      'http://core.test/storefront/shops/shop-1/account/wishlist/..%2Fdata%2Ferase',
    );

    const { client: down } = clientAnswering(() => new Response('down', { status: 503 }));
    await expect(down.accountWishlist('shop-1', 'session-secret')).rejects.toThrow(
      StorefrontApiError,
    );
    await expect(down.accountWishlistAdd('shop-1', 'session-secret', [kurta])).rejects.toThrow(
      StorefrontApiError,
    );
    await expect(down.accountWishlistRemove('shop-1', 'session-secret', kurta)).rejects.toThrow(
      StorefrontApiError,
    );
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
