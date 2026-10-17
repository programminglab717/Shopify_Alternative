import 'reflect-metadata';
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutomaticDiscountService } from './automatic-discount.service.js';
import { chooseDiscounts } from './combining.js';
import { DiscountCodeService } from './discount-code.service.js';
import { automaticSummary, discountSummary } from './discounts.js';
import { itemsOff, type OrderItems } from './items.js';
import type { AutomaticDiscountRecord, DiscountCodeRecord } from './records.js';
import { discountFor } from './redemptions.js';

const AT = new Date('2026-10-17T12:00:00+05:00');
const SINCE = new Date('2026-10-01T00:00:00+05:00');

function automatic(given: Partial<AutomaticDiscountRecord>): AutomaticDiscountRecord {
  return {
    id: 'bogo',
    title: 'Buy 2 get 1 free',
    kind: 'buy_x_get_y',
    percentageBps: 10_000,
    amount: null,
    minimumSubtotal: null,
    buyQuantity: 2,
    getQuantity: 1,
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
    code: 'BOGO',
    title: 'BOGO',
    kind: 'buy_x_get_y',
    percentageBps: 10_000,
    amount: null,
    minimumSubtotal: null,
    buyQuantity: 1,
    getQuantity: 1,
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

/** Two lawn suits at Rs 3,000, a Rs 1,500 dupatta, and three Rs 2,000 kurtas in the sale. */
const ITEMS: OrderItems = {
  subtotal: 1_350_000n,
  lines: [
    { productId: 'lawn', collectionIds: [], quantity: 2, total: 600_000n },
    { productId: 'dupatta', collectionIds: [], quantity: 1, total: 150_000n },
    { productId: 'kurta', collectionIds: ['sale'], quantity: 3, total: 600_000n },
  ],
};

describe('Buy X get Y (ADR-519)', () => {
  it('gives the cheapest of each group of its items at its percentage off', () => {
    // Six items, two groups of three: the dupatta and a kurta free.
    expect(itemsOff(automatic({}), ITEMS)).toBe(350_000n);
    // At 50% off, half of that.
    expect(itemsOff(automatic({ percentageBps: 5_000 }), ITEMS)).toBe(175_000n);
    // Only the sale's three kurtas count: one group, one kurta free.
    expect(itemsOff(automatic({ collectionIds: ['sale'] }), ITEMS)).toBe(200_000n);
    // Buy 3 get 2: six items make one group, the two cheapest given.
    expect(itemsOff(automatic({ buyQuantity: 3, getQuantity: 2 }), ITEMS)).toBe(350_000n);
    // Too few of its items for a group: nothing.
    expect(itemsOff(automatic({ productIds: ['lawn'] }), ITEMS)).toBe(0n);
  });

  it('competes with other automatic discounts by what it takes off, and needs enough items as a code', () => {
    const tenth = automatic({
      id: 'tenth',
      title: '10% off',
      kind: 'percentage',
      percentageBps: 1_000,
      buyQuantity: null,
      getQuantity: null,
    });
    // Rs 3,500 free beats 10% (Rs 1,350).
    expect(chooseDiscounts(ITEMS, null, [tenth, automatic({})], AT)).toMatchObject({
      automatic: [{ id: 'bogo' }],
      items: 350_000n,
    });
    // Too few of the lawn for its own: the 10% applies alone.
    const lawnOnly = automatic({ productIds: ['lawn'] });
    expect(chooseDiscounts(ITEMS, null, [lawnOnly, tenth], AT).automatic).toEqual([tenth]);
    expect(chooseDiscounts(ITEMS, null, [lawnOnly], AT).automatic).toEqual([]);

    // A code for buy 1 get 1 on the lawn: one suit free.
    const applied = discountFor(code({ productIds: ['lawn'] }), { ...ITEMS, shipping: 0n }, AT);
    expect(applied.ok && applied.amounts).toEqual({ items: 300_000n, shipping: 0n });
    expect(discountFor(code({ productIds: ['dupatta'] }), { ...ITEMS, shipping: 0n }, AT)).toEqual({
      ok: false,
      refusal: { reason: 'too_few', count: 2 },
    });
  });

  it('says what it gives in its summary', () => {
    expect(automaticSummary(automatic({}), 'PKR')).toBe('Buy 2, get 1 free');
    expect(
      automaticSummary(
        automatic({ percentageBps: 5_000, collectionIds: ['sale'], minimumSubtotal: 500_000n }),
        'PKR',
      ),
    ).toBe('Buy 2, get 1 at 50% off of 1 collection, when they come to Rs 5,000 or more');
    expect(discountSummary(code({ minimumSubtotal: 300_000n, oncePerCustomer: true }), 'PKR')).toBe(
      'Buy 1, get 1 free on orders of Rs 3,000 or more; one use a customer',
    );
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

describe.skipIf(!server)('Buy X get Y kept (ADR-519)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let codes: DiscountCodeService;
  let automatics: AutomaticDiscountService;
  const a = tenant(newId());

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'pricing-bxgy-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A')`, [a.shopId]);
    codes = new DiscountCodeService(db);
    automatics = new AutomaticDiscountService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('makes one free unless a percentage is given, and keeps its quantities as it changes', async () => {
    const bogo = unwrap(
      await automatics.create(a, { title: 'Buy 2 get 1', buyQuantity: 2, getQuantity: 1 }),
    );
    expect(bogo).toMatchObject({
      kind: 'buy_x_get_y',
      percentageBps: 10_000,
      buyQuantity: 2,
      getQuantity: 1,
      amount: null,
    });
    // A percentage alone changes what the given items take off; it stays buy X get Y.
    expect(unwrap(await automatics.update(a, bogo.id, { percentage: 50 }))).toMatchObject({
      kind: 'buy_x_get_y',
      percentageBps: 5_000,
      buyQuantity: 2,
    });
    // Made an amount off, it forgets its quantities.
    expect(unwrap(await automatics.update(a, bogo.id, { amount: '500' }))).toMatchObject({
      kind: 'fixed_amount',
      percentageBps: null,
      buyQuantity: null,
      getQuantity: null,
    });

    const half = unwrap(
      await codes.create(a, { code: 'HALF', buyQuantity: 1, getQuantity: 1, percentage: 50 }),
    );
    expect(half).toMatchObject({ kind: 'buy_x_get_y', percentageBps: 5_000 });
    expect(errorsOf(await codes.create(a, { code: 'NOGET', buyQuantity: 2 }))).toEqual([
      ['getQuantity', 'BLANK'],
    ]);
    expect(
      errorsOf(await codes.create(a, { code: 'ZERO', buyQuantity: 0, getQuantity: 101 })),
    ).toEqual([
      ['buyQuantity', 'INVALID'],
      ['getQuantity', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await automatics.create(a, {
          title: 'Both',
          buyQuantity: 2,
          getQuantity: 1,
          freeShipping: true,
        }),
      ),
    ).toEqual([['freeShipping', 'INVALID']]);
  });
});
