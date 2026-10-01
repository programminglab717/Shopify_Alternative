import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from './rules.js';
import type { SavedSearchTypeValue } from './schema.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Saved searches', () => {
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
      await f.savedSearches.create(f.a, {
        resourceType: 'order',
        name: '  VIP to pack ',
        query: 'tag:vip stage:to_pack',
      }),
    );
    expect(toPack).toMatchObject({
      name: 'VIP to pack',
      query: 'tag:vip stage:to_pack',
      version: 1,
    });
    const lahore = unwrap(
      await f.savedSearches.create(f.a, {
        resourceType: 'order',
        name: 'Lahore COD',
        query: 'lahore payment_method:cash_on_delivery',
      }),
    );
    // Another shop names its own as it likes.
    unwrap(
      await f.savedSearches.create(f.b, {
        resourceType: 'order',
        name: 'VIP to pack',
        query: 'tag:vip',
      }),
    );

    const first = await f.savedSearches.list(f.a, 'order', { first: 1 });
    expect(first.items.map((search) => search.name)).toEqual(['VIP to pack']);
    expect(first.hasNextPage).toBe(true);
    const next = await f.savedSearches.list(f.a, 'order', { first: 1, after: first.items[0]!.id });
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
    expect((await f.savedSearches.list(f.a, 'order', { first: 10 })).items).toEqual([renamed]);
    expect(await events()).toEqual([
      ['saved_search.created', { resourceType: 'order', version: 1 }],
      ['saved_search.created', { resourceType: 'order', version: 1 }],
      ['saved_search.created', { resourceType: 'order', version: 1 }],
      ['saved_search.updated', { changed: ['name', 'query'], version: 2 }],
      ['saved_search.deleted', {}],
    ]);
  });

  it('checks a name and query as the orders search would read them', async () => {
    unwrap(
      await f.savedSearches.create(f.a, {
        resourceType: 'order',
        name: 'To pack',
        query: 'stage:to_pack',
      }),
    );
    expect(
      errorsOf(
        await f.savedSearches.create(f.a, {
          resourceType: 'order',
          name: 'TO PACK',
          query: 'tag:x',
        }),
      ),
    ).toEqual([['input.name', 'TAKEN']]);
    expect(
      errorsOf(
        await f.savedSearches.create(f.a, {
          resourceType: 'order',
          name: ' ',
          query: 'x'.repeat(1_001),
        }),
      ),
    ).toEqual([
      ['input.name', 'BLANK'],
      ['input.query', 'TOO_LONG'],
    ]);
    const unknown = await f.savedSearches.create(f.a, {
      resourceType: 'order',
      name: 'Packed',
      query: 'stage:packed',
    });
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
      errorsOf(
        await f.savedSearches.create(f.a, {
          resourceType: 'order',
          name: 'x'.repeat(41),
          query: 'tag:x',
        }),
      ),
    ).toEqual([['input.name', 'TOO_LONG']]);
    const other = unwrap(
      await f.savedSearches.create(f.b, { resourceType: 'order', name: 'Theirs', query: 'tag:x' }),
    );
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
      `INSERT INTO orders.saved_searches (shop_id, id, resource_type, name, query)
       SELECT $1, platform.uuidv7(), 'order', 'Search ' || n, 'tag:t' || n
         FROM generate_series(1, $2::int - 1) AS n`,
      [f.a.shopId, LIMITS.savedSearches],
    );
    // Two at once: one is the last there is room for.
    const results = await Promise.all([
      f.savedSearches.create(f.a, { resourceType: 'order', name: 'One', query: 'tag:one' }),
      f.savedSearches.create(f.a, { resourceType: 'order', name: 'Two', query: 'tag:two' }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map(errorsOf)).toEqual([[['input', 'TOO_MANY']]]);
    // Each list has room of its own.
    unwrap(
      await f.savedSearches.create(f.a, { resourceType: 'product', name: 'One', query: 'tag:one' }),
    );
  });

  it('keeps searches of drafts and products too, each checked by its own list (ADR-124)', async () => {
    const save = (resourceType: SavedSearchTypeValue, name: string, query: string) =>
      f.savedSearches.create(f.a, { resourceType, name, query });
    const drafts = unwrap(
      await save('draft_order', 'Open on WhatsApp', 'status:open source:whatsapp'),
    );
    const products = unwrap(await save('product', 'Drafts', 'status:draft'));
    // A name is its list's own: the orders may have a tab of that name too.
    unwrap(await save('order', 'Drafts', 'source:manual'));
    expect(errorsOf(await save('product', 'DRAFTS', 'status:active'))).toEqual([
      ['input.name', 'TAKEN'],
    ]);

    // Each query is checked by its own list's search: an order's stage is no product's filter.
    expect(await save('product', 'To pack', 'stage:to_pack')).toMatchObject({
      ok: false,
      errors: [
        {
          field: ['input', 'query'],
          code: 'INVALID',
          message: expect.stringMatching(/^Products can't be filtered by stage; /),
        },
      ],
    });
    expect(await save('draft_order', 'Active', 'status:active')).toMatchObject({
      ok: false,
      errors: [{ code: 'INVALID', message: 'status is one of open, completed, not active' }],
    });

    // Lists are apart, each oldest first.
    expect((await f.savedSearches.list(f.a, 'product', { first: 10 })).items).toEqual([products]);
    expect((await f.savedSearches.list(f.a, 'draft_order', { first: 10 })).items).toEqual([drafts]);
    expect(
      (await f.savedSearches.list(f.a, 'order', { first: 10 })).items.map((search) => search.name),
    ).toEqual(['Drafts']);

    // A query changed is checked by its list too.
    expect(
      errorsOf(await f.savedSearches.update(f.a, products.id, { query: 'stage:to_pack' })),
    ).toEqual([['input.query', 'INVALID']]);
    expect(
      unwrap(
        await f.savedSearches.update(f.a, products.id, { query: 'status:draft vendor:Khaadi' }),
      ),
    ).toMatchObject({ resourceType: 'product', query: 'status:draft vendor:Khaadi', version: 2 });
    expect(await f.savedSearches.resourceTypeOf(f.a, drafts.id)).toBe('draft_order');
    expect(await f.savedSearches.resourceTypeOf(f.b, drafts.id)).toBeNull();
    expect((await events()).filter(([type]) => type === 'saved_search.created')).toEqual([
      ['saved_search.created', { resourceType: 'draft_order', version: 1 }],
      ['saved_search.created', { resourceType: 'product', version: 1 }],
      ['saved_search.created', { resourceType: 'order', version: 1 }],
    ]);
  });
});
