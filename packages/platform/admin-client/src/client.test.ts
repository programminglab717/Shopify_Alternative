import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HattiAdminApiError, HattiAdminClient, isMutation, verifyWebhook } from './index.js';

type Asked = {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
};

/** A fake Admin API answering each request from `answers`, in turn, each request kept. */
function api(answers: (Response | (() => Response))[]) {
  const asked: Asked[] = [];
  const waited: number[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    asked.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Asked['body'],
    });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof globalThis.fetch;
  const client = new HattiAdminClient({
    apiUrl: 'https://api.hatti.test',
    accessToken: 'hat_secret',
    fetch,
    sleep: async (ms) => {
      waited.push(ms);
    },
  });
  return { client, asked, waited };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const COST = (available: number) => ({
  requestedQueryCost: 52,
  actualQueryCost: null,
  throttleStatus: { maximumAvailable: 1000, currentlyAvailable: available, restoreRate: 50 },
});

describe("A client for Hatti's Admin API (DEV-09, ADR-850)", () => {
  it('asks with the token at the dated version, and gives the data and its cost', async () => {
    const { client, asked } = api([
      json({ data: { shop: { name: 'Zari' } }, extensions: { cost: COST(948) } }),
    ]);
    expect(await client.request('{ shop { name } }')).toEqual({
      data: { shop: { name: 'Zari' } },
      cost: COST(948),
    });
    expect(asked[0]).toMatchObject({
      url: 'https://api.hatti.test/admin/api/2026-10/graphql',
      headers: { 'x-hatti-access-token': 'hat_secret', 'content-type': 'application/json' },
    });
    // A query carries no idempotency key.
    expect(asked[0]!.headers['idempotency-key']).toBeUndefined();
  });

  it('waits out a throttle as its cost says, and keeps one idempotency key across tries', async () => {
    const throttled = () =>
      json({
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: { cost: COST(2) },
      });
    const { client, asked, waited } = api([
      throttled,
      () => new Response('busy', { status: 503 }),
      json({ data: { productCreate: { product: { id: 'prod_1' } } } }),
    ]);
    const mutation =
      '# a comment\nmutation { productCreate(input: { title: "Kurta" }) { product { id } } }';
    expect((await client.request(mutation)).data).toEqual({
      productCreate: { product: { id: 'prod_1' } },
    });
    // (52 - 2) points at 50 a second: a second.
    expect(waited).toEqual([1000, 1000]);
    const keys = asked.map((each) => each.headers['idempotency-key']);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(1);
  });

  it('throws what the API said, past its tries, or for errors it does not retry', async () => {
    const { client } = api([
      json(
        {
          errors: [
            {
              message: 'Field "nope" is not defined',
              extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
            },
          ],
        },
        400,
      ),
    ]);
    const failure = await client.request('{ nope }').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HattiAdminApiError);
    expect(failure).toMatchObject({ status: 400, message: 'Field "nope" is not defined' });
    const busy = api(Array.from({ length: 4 }, () => () => new Response('busy', { status: 502 })));
    await expect(busy.client.request('{ shop { name } }')).rejects.toMatchObject({ status: 502 });
    expect(busy.waited).toEqual([500, 1000, 2000]);
  });

  it('reads a connection a page at a time', async () => {
    const page = (ids: string[], next: string | null) =>
      json({
        data: {
          products: {
            nodes: ids.map((id) => ({ id })),
            pageInfo: { hasNextPage: next !== null, endCursor: next },
          },
        },
      });
    const { client, asked } = api([page(['a', 'b'], 'c2'), page(['c'], null)]);
    const ids: string[] = [];
    for await (const product of client.paginate<{ id: string }, { products: never }>(
      'query ($after: String) { products(first: 2, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }',
      {},
      (data) => data.products,
    )) {
      ids.push(product.id);
    }
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(asked.map((each) => each.body.variables.after)).toEqual([null, 'c2']);
  });

  it('refuses an address that is not https, and tells mutations from queries', () => {
    expect(() => new HattiAdminClient({ apiUrl: 'http://api.hatti.pk', accessToken: 't' })).toThrow(
      /https/,
    );
    expect(isMutation('  mutation M { x }')).toBe(true);
    expect(isMutation('query { mutationLog }')).toBe(false);
  });

  it("checks a webhook's signature against the raw body", () => {
    const body = '{"id":"ord_1"}';
    const signature = createHmac('sha256', 'whsec').update(body).digest('base64');
    expect(verifyWebhook(body, signature, 'whsec')).toBe(true);
    expect(verifyWebhook(`${body} `, signature, 'whsec')).toBe(false);
    expect(verifyWebhook(body, signature, 'other')).toBe(false);
    expect(verifyWebhook(body, null, 'whsec')).toBe(false);
  });
});
