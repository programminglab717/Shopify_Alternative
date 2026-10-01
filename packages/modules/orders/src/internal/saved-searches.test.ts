import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from './rules.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Saved order searches', () => {
  let f: OrdersFixture;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const events = async () =>
    (await f.outbox())
      .filter((event) => event.event_type.startsWith('saved_search.'))
      .map((event) => [event.event_type, event.payload]);

  it('keeps searches of the orders by name, for the whole shop, oldest first', async () => {
    const toPack = unwrap(
      await f.savedSearches.create(f.a, { name: '  VIP to pack ', query: 'tag:vip stage:to_pack' }),
    );
    expect(toPack).toMatchObject({
      name: 'VIP to pack',
      query: 'tag:vip stage:to_pack',
      version: 1,
    });
    const lahore = unwrap(
      await f.savedSearches.create(f.a, {
        name: 'Lahore COD',
        query: 'lahore payment_method:cash_on_delivery',
      }),
    );
    // Another shop names its own as it likes.
    unwrap(await f.savedSearches.create(f.b, { name: 'VIP to pack', query: 'tag:vip' }));

    const first = await f.savedSearches.list(f.a, { first: 1 });
    expect(first.items.map((search) => search.name)).toEqual(['VIP to pack']);
    expect(first.hasNextPage).toBe(true);
    const next = await f.savedSearches.list(f.a, { first: 1, after: first.items[0]!.id });
    expect(next).toEqual({ items: [lahore], hasNextPage: false });

    // Renamed, or given another query: it keeps its place.
    const renamed = unwrap(
      await f.savedSearches.update(f.a, toPack.id, {
        name: 'VIP, to pack',
        query: '-stage:to_pack tag:vip',
      }),
    );
    expect(renamed).toMatchObject({
      name: 'VIP, to pack',
      query: '-stage:to_pack tag:vip',
      version: 2,
    });
    // The same again changes nothing.
    expect(unwrap(await f.savedSearches.update(f.a, toPack.id, { name: 'VIP, to pack' }))).toEqual(
      renamed,
    );
    expect(unwrap(await f.savedSearches.delete(f.a, lahore.id))).toEqual({ id: lahore.id });
    expect((await f.savedSearches.list(f.a, { first: 10 })).items).toEqual([renamed]);
    expect(await events()).toEqual([
      ['saved_search.created', { version: 1 }],
      ['saved_search.created', { version: 1 }],
      ['saved_search.created', { version: 1 }],
      ['saved_search.updated', { changed: ['name', 'query'], version: 2 }],
      ['saved_search.deleted', {}],
    ]);
  });

  it('checks a name and query as the orders search would read them', async () => {
    unwrap(await f.savedSearches.create(f.a, { name: 'To pack', query: 'stage:to_pack' }));
    expect(
      errorsOf(await f.savedSearches.create(f.a, { name: 'TO PACK', query: 'tag:x' })),
    ).toEqual([['input.name', 'TAKEN']]);
    expect(
      errorsOf(await f.savedSearches.create(f.a, { name: ' ', query: 'x'.repeat(1_001) })),
    ).toEqual([
      ['input.name', 'BLANK'],
      ['input.query', 'TOO_LONG'],
    ]);
    const unknown = await f.savedSearches.create(f.a, { name: 'Packed', query: 'stage:packed' });
    expect(unknown).toMatchObject({
      ok: false,
      errors: [
        {
          field: ['input', 'query'],
          code: 'INVALID',
          message: expect.stringMatching(/^stage is one of needs_confirmation, /),
        },
      ],
    });
    expect(
      errorsOf(await f.savedSearches.create(f.a, { name: 'x'.repeat(41), query: 'tag:x' })),
    ).toEqual([['input.name', 'TOO_LONG']]);
    const other = unwrap(await f.savedSearches.create(f.b, { name: 'Theirs', query: 'tag:x' }));
    expect(errorsOf(await f.savedSearches.update(f.a, other.id, { name: 'Mine' }))).toEqual([
      ['input.id', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.savedSearches.delete(f.a, other.id))).toEqual([
      ['input.id', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.savedSearches.delete(f.a, newId()))).toEqual([
      ['input.id', 'NOT_FOUND'],
    ]);
  });

  it(`keeps at most ${LIMITS.savedSearches} a shop`, async () => {
    await f.admin.query(
      `INSERT INTO orders.saved_searches (shop_id, id, name, query)
       SELECT $1, platform.uuidv7(), 'Search ' || n, 'tag:t' || n
         FROM generate_series(1, $2::int - 1) AS n`,
      [f.a.shopId, LIMITS.savedSearches],
    );
    // Two at once: one is the last there is room for.
    const results = await Promise.all([
      f.savedSearches.create(f.a, { name: 'One', query: 'tag:one' }),
      f.savedSearches.create(f.a, { name: 'Two', query: 'tag:two' }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map(errorsOf)).toEqual([[['input', 'TOO_MANY']]]);
  });
});
