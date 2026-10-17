import 'reflect-metadata';
import type { MutationResult, TenantContext } from '@hatti/api';
import { collectionsOfProductsIn } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutomaticDiscountService } from './automatic-discount.service.js';
import { chooseDiscounts } from './combining.js';
import { DiscountCodeService } from './discount-code.service.js';
import { automaticSummary, discountSummary } from './discounts.js';
import { collectionsNamed, itemsFor, type OrderItems } from './items.js';
import type { AutomaticDiscountRecord, DiscountCodeRecord } from './records.js';
import { discountFor } from './redemptions.js';

const AT = new Date('2026-10-17T12:00:00+05:00');
const SINCE = new Date('2026-10-01T00:00:00+05:00');
const LAWN = 'lawn';
const KHUSSA = 'khussa';
const SALE = 'sale-collection';

function automatic(given: Partial<AutomaticDiscountRecord>): AutomaticDiscountRecord {
  return {
    id: 'auto',
    title: 'Lawn sale',
    kind: 'percentage',
    percentageBps: 2_000,
    amount: null,
    minimumSubtotal: null,
    startsAt: SINCE,
    endsAt: null,
    combinesWithCodes: false,
    productIds: [],
    collectionIds: [],
    version: 1,
    createdAt: SINCE,
    updatedAt: SINCE,
    ...given,
  };
}

function code(given: Partial<DiscountCodeRecord>): DiscountCodeRecord {
  return {
    id: 'code',
    code: 'KHUSSA500',
    title: 'KHUSSA500',
    kind: 'fixed_amount',
    percentageBps: null,
    amount: 50_000n,
    minimumSubtotal: null,
    startsAt: SINCE,
    endsAt: null,
    usageLimit: null,
    oncePerCustomer: false,
    used: 0,
    productIds: [],
    collectionIds: [],
    version: 1,
    createdAt: SINCE,
    updatedAt: SINCE,
    ...given,
  };
}

/** Rs 6,000 of lawn, in the sale collection, and Rs 3,000 of khussas. */
const ITEMS: OrderItems = {
  subtotal: 900_000n,
  lines: [
    { productId: LAWN, collectionIds: [SALE], total: 600_000n },
    { productId: KHUSSA, collectionIds: [], total: 300_000n },
  ],
};

describe('Discounts for some products or collections (ADR-517)', () => {
  it('takes off only the items of the products and collections named, their minimum theirs', () => {
    const forSale = automatic({ collectionIds: [SALE] });
    expect(itemsFor(forSale, ITEMS)).toBe(600_000n);
    expect(itemsFor(automatic({ productIds: [KHUSSA], collectionIds: [SALE] }), ITEMS)).toBe(
      900_000n,
    );
    expect(itemsFor(automatic({}), ITEMS)).toBe(900_000n);
    expect(collectionsNamed([forSale, null, code({ collectionIds: [SALE, 'other'] })])).toEqual([
      SALE,
      'other',
    ]);

    // 20% of the lawn alone: Rs 1,200, not Rs 1,800.
    expect(chooseDiscounts(ITEMS, null, [forSale], AT)).toMatchObject({
      items: 120_000n,
      byAutomatic: 120_000n,
    });
    // Its minimum is what the lawn comes to: Rs 7,000 is more than Rs 6,000.
    const over = automatic({ collectionIds: [SALE], minimumSubtotal: 700_000n });
    expect(chooseDiscounts(ITEMS, null, [over], AT).automatic).toEqual([]);
    // For products the order lacks, it applies to nothing.
    const absent = automatic({ productIds: ['shawl'] });
    expect(chooseDiscounts(ITEMS, null, [absent], AT).automatic).toEqual([]);

    // An amount off is once an order, no more than the items it is for come to.
    const khussas = code({ productIds: [KHUSSA], amount: 400_000n });
    const applied = discountFor(khussas, { ...ITEMS, shipping: 0n }, AT);
    expect(applied.ok && applied.amounts.items).toBe(300_000n);
    // Beside the sale, which doesn't combine, the code's Rs 3,000 beats its Rs 1,200.
    expect(chooseDiscounts(ITEMS, khussas, [forSale], AT)).toMatchObject({
      code: khussas,
      automatic: [],
      items: 300_000n,
      byCode: 300_000n,
    });
  });

  it("refuses a code for items the order hasn't, or whose items miss its minimum", () => {
    const shawls = code({ productIds: ['shawl'] });
    expect(discountFor(shawls, { ...ITEMS, shipping: 0n }, AT)).toEqual({
      ok: false,
      refusal: { reason: 'not_for_items' },
    });
    // Without the lines, a code for some items finds none.
    expect(
      discountFor(code({ productIds: [LAWN] }), { subtotal: 900_000n, shipping: 0n }, AT),
    ).toEqual({ ok: false, refusal: { reason: 'not_for_items' } });
    const minimum = code({ productIds: [KHUSSA], minimumSubtotal: 500_000n });
    expect(discountFor(minimum, { ...ITEMS, shipping: 0n }, AT)).toEqual({
      ok: false,
      refusal: { reason: 'minimum', minimum: 500_000n },
    });
  });

  it('says what it is for in its summary', () => {
    expect(
      discountSummary(code({ productIds: [LAWN, KHUSSA], collectionIds: [SALE] }), 'PKR'),
    ).toBe('Rs 500 off 2 products and 1 collection');
    expect(
      automaticSummary(
        automatic({ collectionIds: [SALE, 'other'], minimumSubtotal: 300_000n }),
        'PKR',
      ),
    ).toBe('20% off 2 collections, when they come to Rs 3,000 or more');
  });
});

const server = testDatabaseServer();

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_discounts']),
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

describe.skipIf(!server)('Discounts kept for some products or collections (ADR-517)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let codes: DiscountCodeService;
  let automatics: AutomaticDiscountService;
  const a = tenant(newId());
  const b = tenant(newId());
  const lawn = newId();
  const khussa = newId();
  const sale = newId();
  const theirs = newId();

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'pricing-scoped-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    await admin.query(
      `INSERT INTO catalog.products (shop_id, id, title, handle)
       VALUES ($1, $2, 'Lawn', 'lawn'), ($1, $3, 'Khussa', 'khussa'), ($4, $5, 'Theirs', 'theirs')`,
      [a.shopId, lawn, khussa, b.shopId, theirs],
    );
    await admin.query(
      `INSERT INTO catalog.collections (shop_id, id, title, handle) VALUES ($1, $2, 'Sale', 'sale')`,
      [a.shopId, sale],
    );
    await admin.query(
      `INSERT INTO catalog.collection_products (shop_id, collection_id, product_id)
       VALUES ($1, $2, $3)`,
      [a.shopId, sale, lawn],
    );
    codes = new DiscountCodeService(db);
    automatics = new AutomaticDiscountService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("keeps the shop's own products and collections, and finds none of another's", async () => {
    const made = unwrap(
      await codes.create(a, {
        code: 'LAWN20',
        percentage: 20,
        productIds: [khussa, khussa],
        collectionIds: [sale],
      }),
    );
    expect(made).toMatchObject({ productIds: [khussa], collectionIds: [sale] });
    expect(
      errorsOf(await codes.create(a, { code: 'THEIRS', percentage: 5, productIds: [theirs] })),
    ).toEqual([['productIds.0', 'NOT_FOUND']]);
    expect(
      errorsOf(
        await automatics.create(a, {
          title: 'Wrong',
          amount: '500',
          collectionIds: [sale, newId()],
        }),
      ),
    ).toEqual([['collectionIds.1', 'NOT_FOUND']]);

    // Free delivery is for the whole order; made so, it forgets what it was for.
    expect(
      errorsOf(
        await automatics.create(a, { title: 'Free', freeShipping: true, productIds: [lawn] }),
      ),
    ).toEqual([['productIds', 'INVALID']]);
    const free = unwrap(await codes.update(a, made.id, { freeShipping: true }));
    expect(free).toMatchObject({ kind: 'free_shipping', productIds: [], collectionIds: [] });

    // The same list again changes nothing; cleared, it is for the whole order.
    const sale20 = unwrap(
      await automatics.create(a, { title: 'Sale', percentage: 20, collectionIds: [sale] }),
    );
    expect(unwrap(await automatics.update(a, sale20.id, { collectionIds: [sale] })).version).toBe(
      1,
    );
    expect(unwrap(await automatics.update(a, sale20.id, { collectionIds: null }))).toMatchObject({
      collectionIds: [],
      version: 2,
    });

    // Checkout asks which of the collections named each product is in.
    const of = await db.tenant(a.shopId, (tx) =>
      collectionsOfProductsIn(tx, a.shopId, [lawn, khussa], [sale]),
    );
    expect([...of]).toEqual([[lawn, [sale]]]);
  });
});
