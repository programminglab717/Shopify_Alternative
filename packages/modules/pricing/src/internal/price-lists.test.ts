import 'reflect-metadata';
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PriceListService, listPricesIn } from './price-lists.js';
import { priceListPrices, priceLists } from './schema.js';

const server = testDatabaseServer();

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products']),
  };
}

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function errorsOf(result: MutationResult<unknown>): [string, string][] {
  if (result.ok) throw new Error('Expected user errors, got success');
  return result.errors.map((error) => [error.field.join('.'), error.code]);
}

describe.skipIf(!server)('Price lists for wholesale customers (CUS-06, ADR-778)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let lists: PriceListService;
  const a = tenant(newId());
  const b = tenant(newId());
  const [lawn, kurta, theirs] = [newId(), newId(), newId()];

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'pricing-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    const [product, second, other] = [newId(), newId(), newId()];
    await admin.query(
      `INSERT INTO catalog.products (shop_id, id, title, handle)
       VALUES ($1, $2, 'Lawn', 'lawn'), ($1, $3, 'Kurta', 'kurta'), ($4, $5, 'Theirs', 'theirs')`,
      [a.shopId, product, second, b.shopId, other],
    );
    await admin.query(
      `INSERT INTO catalog.variants (shop_id, id, product_id, price)
       VALUES ($1, $2, $3, 300000), ($1, $4, $5, 200000), ($6, $7, $8, 100000)`,
      [a.shopId, lawn, product, kurta, second, b.shopId, theirs, other],
    );
    lists = new PriceListService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM pricing.price_lists; DELETE FROM platform.outbox_events');
  });

  it('matches the migrated tables', async () => {
    await db.tenant(a.shopId, async (tx) => {
      for (const table of [priceLists, priceListPrices]) await tx.select().from(table).limit(1);
    });
  });

  it("prices a wholesale customer's lines: its own prices, its share off, and quantity breaks", async () => {
    const wholesale = unwrap(
      await lists.create(a, {
        name: 'Wholesale',
        customerTag: 'Wholesale',
        percentOff: '20',
        quantityBreaks: [
          { minQuantity: 12, percentOff: '5' },
          { minQuantity: 50, percentOff: '10' },
        ],
      }),
    );
    expect(wholesale).toMatchObject({
      percentOffBps: 2000,
      quantityBreaks: [
        { minQuantity: 12, percentOffBps: 500 },
        { minQuantity: 50, percentOffBps: 1000 },
      ],
      pricedVariants: 0,
    });
    const prices = unwrap(
      await lists.setPrices(a, wholesale.id, [{ variantId: lawn, price: '1800' }]),
    );
    // Named as the admin shows them (ADR-779): a product's only variant goes by its product's title.
    expect(prices).toEqual([
      {
        variantId: lawn,
        price: 180_000n,
        productTitle: 'Lawn',
        variantTitle: null,
        retailPrice: 300_000n,
      },
    ]);

    const priced = (tags: string[], quantity: number) =>
      db.tenant(a.shopId, (tx) =>
        listPricesIn(tx, a.shopId, tags, [
          { variantId: lawn, quantity, price: 300_000n },
          { variantId: kurta, quantity, price: 200_000n },
        ]),
      );
    // Its own price for the lawn, 20% off the kurta; the tag in any letter case.
    expect((await priced([' wholesale '], 1)).map((each) => each?.price)).toEqual([
      180_000n,
      160_000n,
    ]);
    // A dozen takes 5% more off, fifty 10%.
    expect((await priced(['WHOLESALE'], 12)).map((each) => each?.price)).toEqual([
      171_000n,
      152_000n,
    ]);
    expect((await priced(['wholesale'], 60)).map((each) => each?.price)).toEqual([
      162_000n,
      144_000n,
    ]);
    // A customer without the tag pays what anyone pays.
    expect(await priced(['vip'], 60)).toEqual([null, null]);

    // Of two lists of theirs, the lower price wins, line by line.
    const reseller = unwrap(
      await lists.create(a, { name: 'Resellers', customerTag: 'reseller', percentOff: '25' }),
    );
    expect(
      (await priced(['wholesale', 'reseller'], 1)).map(
        (each) => each && [each.priceListName, each.price],
      ),
    ).toEqual([
      ['Wholesale', 180_000n],
      ['Resellers', 150_000n],
    ]);
    expect(reseller.pricedVariants).toBe(0);
    expect((await lists.list(a)).map((each) => [each.name, each.pricedVariants])).toEqual([
      ['Wholesale', 1],
      ['Resellers', 0],
    ]);

    // A price taken away leaves the share off.
    unwrap(await lists.setPrices(a, wholesale.id, [{ variantId: lawn, price: null }]));
    expect((await priced(['wholesale'], 1))[0]?.price).toBe(240_000n);
  });

  it('checks what a list keeps, and keeps each shop to its own', async () => {
    unwrap(await lists.create(a, { name: 'Wholesale', customerTag: 'wholesale' }));
    expect(errorsOf(await lists.create(a, { name: 'Again', customerTag: 'WHOLESALE' }))).toEqual([
      ['input.customerTag', 'TAKEN'],
    ]);
    expect(
      errorsOf(
        await lists.create(a, {
          name: '',
          customerTag: 'b2b',
          percentOff: '95',
          quantityBreaks: [
            { minQuantity: 10, percentOff: '5' },
            { minQuantity: 10, percentOff: '6' },
          ],
        }),
      ),
    ).toEqual([
      ['input.name', 'BLANK'],
      ['input.percentOff', 'INVALID'],
      ['input.quantityBreaks.1.minQuantity', 'INVALID'],
    ]);
    const list = unwrap(await lists.create(a, { name: 'B2B', customerTag: 'b2b' }));
    // Another shop's variant is not this shop's to price.
    expect(
      errorsOf(await lists.setPrices(a, list.id, [{ variantId: theirs, price: '100' }])),
    ).toEqual([['prices.0.variantId', 'NOT_FOUND']]);
    const updated = unwrap(
      await lists.update(a, list.id, { percentOff: '7.5', quantityBreaks: [] }),
    );
    expect(updated).toMatchObject({ percentOffBps: 750, version: 2 });
    expect(await lists.list(b)).toEqual([]);
    expect(errorsOf(await lists.update(b, list.id, { name: 'Mine' }))).toEqual([
      ['input.id', 'NOT_FOUND'],
    ]);
    unwrap(await lists.delete(a, list.id));
    const { rows } = await admin.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_events ORDER BY id`,
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'price_list.created',
      'price_list.created',
      'price_list.updated',
      'price_list.deleted',
    ]);
  });
});
