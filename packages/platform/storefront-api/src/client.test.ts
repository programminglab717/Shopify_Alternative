import { describe, expect, it } from 'vitest';
import { CartApiError, CartClient, type CartJson } from './index.js';

const EMPTY: CartJson = {
  note: '',
  attributes: {},
  items: [],
  itemCount: 0,
  subtotal: 0,
  totalWeightGrams: 0,
};

/** A client whose requests go to `answer`, which records them. */
function clientAnswering(answer: (request: Request) => Response) {
  const requests: Request[] = [];
  const client = new CartClient({
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

describe('CartClient', () => {
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
    expect(await client.startCheckout('shop-1', 'gone')).toEqual({
      ok: false,
      error: { code: 'EMPTY' },
    });
  });

  it("fetches a checkout's page, and posts its form as JSON", async () => {
    const page = { placed: false, status: 200, headers: { 'x-a': '1' }, html: '<p>Hi</p>' };
    const { client, requests } = clientAnswering((request) =>
      Response.json(request.method === 'GET' ? page : { placed: true }),
    );
    expect(await client.checkoutPage('shop-1', 'c-secret', null)).toEqual(page);
    expect(await client.checkoutPage('shop-1', 'c-secret', { name: 'Ayesha' })).toEqual({
      placed: true,
    });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', 'http://core.test/storefront/shops/shop-1/checkouts/c-secret'],
      ['POST', 'http://core.test/storefront/shops/shop-1/checkouts/c-secret'],
    ]);
    expect(requests[0]!.headers.get('x-hatti-cart')).toBeNull();
    expect(await requests[1]!.json()).toEqual({ name: 'Ayesha' });
  });

  it('throws when the core answers otherwise', async () => {
    const { client } = clientAnswering(() => new Response('Unauthorized', { status: 401 }));
    await expect(client.read('shop-1', 'secret')).rejects.toThrow(CartApiError);
    await expect(client.act('shop-1', null, 'clear', {})).rejects.toThrow(
      "The core's cart API answered 401: Unauthorized",
    );
  });
});
