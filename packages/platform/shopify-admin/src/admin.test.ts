import { describe, expect, it, vi } from 'vitest';
import { SHOPIFY_API_VERSION, ShopifyAdmin } from './admin.js';

const SHOP = 'zari-kurtas.myshopify.com';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe("A store's Admin API (ADR-749)", () => {
  it('asks the GraphQL endpoint at the store with its token, and gives the data', async () => {
    const fetch = vi.fn(async () => json({ data: { shop: { name: 'Zari' } } }));
    const admin = new ShopifyAdmin({ shop: SHOP, credentials: { accessToken: 'shpat_1' }, fetch });
    expect(await admin.graphql('{ shop { name } }')).toEqual({
      ok: true,
      value: { shop: { name: 'Zari' } },
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect((init.headers as Record<string, string>)['x-shopify-access-token']).toBe('shpat_1');
    expect(JSON.parse(String(init.body))).toEqual({ query: '{ shop { name } }' });
  });

  it("takes a day's token for a Dev Dashboard app's client ID and secret, once", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/admin/oauth/access_token')
        ? json({ access_token: 'shpat_day', scope: 'read_products', expires_in: 86_399 })
        : json({ data: { ok: true } }),
    );
    const admin = new ShopifyAdmin({
      shop: SHOP,
      credentials: { clientId: 'client', clientSecret: 'secret' },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await admin.graphql('{ a }');
    await admin.graphql('{ b }');
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url.replace(`https://${SHOP}`, ''))).toEqual([
      '/admin/oauth/access_token',
      `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    ]);
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({
      client_id: 'client',
      client_secret: 'secret',
      grant_type: 'client_credentials',
    });
    expect((calls[2]![1].headers as Record<string, string>)['x-shopify-access-token']).toBe(
      'shpat_day',
    );

    const refused = new ShopifyAdmin({
      shop: SHOP,
      credentials: { clientId: 'client', clientSecret: 'wrong' },
      fetch: async () => json({ error: 'invalid_client' }, 400),
    });
    expect(await refused.graphql('{ a }')).toMatchObject({ ok: false, kind: 'credentials' });
  });

  it('waits out a throttled query for as long as the store needs to restore its cost', async () => {
    const sleep = vi.fn(async () => {});
    const throttled = json({
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
      extensions: {
        cost: {
          requestedQueryCost: 300,
          throttleStatus: { currentlyAvailable: 50, restoreRate: 100 },
        },
      },
    });
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '1.0' }))
      .mockResolvedValueOnce(json({ data: { done: true } }));
    const admin = new ShopifyAdmin({
      shop: SHOP,
      credentials: { accessToken: 't' },
      fetch,
      sleep,
    });
    expect(await admin.graphql('{ done }')).toEqual({ ok: true, value: { done: true } });
    expect(sleep.mock.calls).toEqual([[3_000], [1_000]]);
  });

  it("says why Shopify did not answer, in the owner's terms", async () => {
    const answer = async (response: Response) =>
      new ShopifyAdmin({
        shop: SHOP,
        credentials: { accessToken: 't' },
        fetch: async () => response,
        sleep: async () => {},
      }).graphql('{ shop { name } }');
    expect(await answer(json({}, 401))).toMatchObject({ kind: 'credentials' });
    expect(await answer(json({}, 402))).toMatchObject({ kind: 'store' });
    expect(await answer(json({}, 403))).toMatchObject({ kind: 'scope' });
    expect(await answer(json({}, 404))).toMatchObject({
      kind: 'store',
      message: `There is no Shopify store at ${SHOP}`,
    });
    expect(await answer(json({}, 503))).toMatchObject({ kind: 'busy' });
    expect(
      await answer(json({ errors: [{ message: 'no', extensions: { code: 'ACCESS_DENIED' } }] })),
    ).toMatchObject({ kind: 'scope' });
    expect(await answer(json({ errors: [{ message: "Field 'x' doesn't exist" }] }))).toEqual({
      ok: false,
      kind: 'other',
      message: "Shopify said: Field 'x' doesn't exist",
    });
    expect(
      await new ShopifyAdmin({
        shop: SHOP,
        credentials: { accessToken: 't' },
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      }).graphql('{ a }'),
    ).toMatchObject({ kind: 'busy' });
  });

  it("reads a bulk query's file from an https link alone", async () => {
    const admin = new ShopifyAdmin({
      shop: SHOP,
      credentials: { accessToken: 't' },
      fetch: async () => new Response('{"id":"1"}\n'),
    });
    expect(await admin.download('https://storage.googleapis.com/shopify/file.jsonl')).toEqual({
      ok: true,
      value: '{"id":"1"}\n',
    });
    expect(await admin.download('http://storage.googleapis.com/file')).toMatchObject({
      ok: false,
    });
  });
});
