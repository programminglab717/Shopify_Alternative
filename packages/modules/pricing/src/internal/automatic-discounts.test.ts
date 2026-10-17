import 'reflect-metadata';
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOMATIC_DISCOUNT_LIMIT,
  AutomaticDiscountService,
  runningAutomaticDiscountsIn,
  type AutomaticDiscountInput,
} from './automatic-discount.service.js';
import { automaticDiscounts } from './schema.js';

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

describe.skipIf(!server)('AutomaticDiscountService (ADR-515)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let discounts: AutomaticDiscountService;
  const a = tenant(newId());
  const b = tenant(newId());

  const create = (input: AutomaticDiscountInput, owner = a) => discounts.create(owner, input);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'pricing-automatic-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    discounts = new AutomaticDiscountService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM pricing.automatic_discounts; DELETE FROM platform.outbox_events',
    );
  });

  it('matches the migrated table', async () => {
    await db.tenant(a.shopId, (tx) => tx.select().from(automaticDiscounts).limit(1));
  });

  it('makes, changes and deletes them, each event recorded, and keeps them to the shop', async () => {
    const eid = unwrap(
      await create({ title: ' Eid sale ', percentage: 10, minimumSubtotal: '3,000' }),
    );
    expect(eid).toMatchObject({
      title: 'Eid sale',
      kind: 'percentage',
      percentageBps: 1_000,
      amount: null,
      minimumSubtotal: 300_000n,
      endsAt: null,
      combinesWithCodes: false,
      version: 1,
    });
    const delivery = unwrap(await create({ title: 'Free delivery', freeShipping: true }));
    expect(delivery).toMatchObject({ kind: 'free_shipping', percentageBps: null });

    const changed = unwrap(
      await discounts.update(a, eid.id, { amount: '500', combinesWithCodes: true }),
    );
    expect(changed).toMatchObject({
      kind: 'fixed_amount',
      percentageBps: null,
      amount: 50_000n,
      combinesWithCodes: true,
      version: 2,
    });
    // Nothing changed, nothing recorded.
    expect(unwrap(await discounts.update(a, eid.id, { title: 'Eid sale' })).version).toBe(2);

    expect((await discounts.list(a)).map((discount) => discount.title)).toEqual([
      'Free delivery',
      'Eid sale',
    ]);
    expect(await discounts.list(b)).toEqual([]);
    expect(await discounts.get(b, eid.id)).toBeNull();
    expect(errorsOf(await discounts.update(b, eid.id, { title: 'x' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);

    expect(unwrap(await discounts.delete(a, delivery.id))).toEqual({ id: delivery.id });
    expect(errorsOf(await discounts.delete(a, delivery.id))).toEqual([['id', 'NOT_FOUND']]);

    const { rows } = await admin.query<{ event_type: string }>(
      'SELECT event_type FROM platform.outbox_events ORDER BY occurred_at, id',
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'automatic_discount.created',
      'automatic_discount.created',
      'automatic_discount.updated',
      'automatic_discount.deleted',
    ]);
  });

  it('refuses one without a title or saying what it gives, or with dates the wrong way', async () => {
    expect(errorsOf(await create({ percentage: 10 }))).toEqual([['title', 'BLANK']]);
    expect(errorsOf(await create({ title: 'Sale' }))).toEqual([['percentage', 'BLANK']]);
    expect(errorsOf(await create({ title: 'Sale', percentage: 10, amount: '500' }))).toEqual([
      ['amount', 'INVALID'],
    ]);
    expect(errorsOf(await create({ title: 'Sale', percentage: 150 }))).toEqual([
      ['percentage', 'INVALID'],
    ]);
    const result = await create({
      title: 'Sale',
      freeShipping: true,
      startsAt: new Date('2026-11-02T00:00:00Z'),
      endsAt: new Date('2026-11-01T00:00:00Z'),
    });
    expect(errorsOf(result)).toEqual([['endsAt', 'INVALID']]);
    if (!result.ok) {
      expect(result.errors[0]!.message).toBe('Ends at must be later than starts at');
    }
    const giving = await create({ title: 'Sale' });
    if (!giving.ok) {
      expect(giving.errors[0]!.message).toBe(
        'Say what the discount gives: a percentage off, an amount off, or free delivery',
      );
    }
  });

  it(`keeps ${AUTOMATIC_DISCOUNT_LIMIT} a shop at most`, async () => {
    await admin.query(
      `INSERT INTO pricing.automatic_discounts (shop_id, id, title, kind)
       SELECT $1, gen_random_uuid(), 'Sale ' || n, 'free_shipping'
       FROM generate_series(1, $2::int) AS n`,
      [a.shopId, AUTOMATIC_DISCOUNT_LIMIT],
    );
    expect(errorsOf(await create({ title: 'One more', freeShipping: true }))).toEqual([
      ['', 'TOO_MANY'],
    ]);
    unwrap(await create({ title: 'Another shop', freeShipping: true }, b));
  });

  it('gives carts and checkouts those that run now, oldest first', async () => {
    const now = new Date();
    const first = unwrap(await create({ title: 'First', percentage: 5 }));
    const second = unwrap(await create({ title: 'Second', freeShipping: true }));
    unwrap(
      await create({
        title: 'Ahead',
        percentage: 50,
        startsAt: new Date(now.getTime() + 86_400_000),
      }),
    );
    const ended = unwrap(await create({ title: 'Ended', percentage: 50 }));
    unwrap(await discounts.update(a, ended.id, { endsAt: new Date(now.getTime() + 1_000) }));
    const running = await db.tenant(a.shopId, (tx) =>
      runningAutomaticDiscountsIn(tx, a.shopId, new Date(now.getTime() + 2_000)),
    );
    expect(running.map((discount) => discount.id)).toEqual([first.id, second.id]);
    expect(await db.tenant(b.shopId, (tx) => runningAutomaticDiscountsIn(tx, b.shopId))).toEqual(
      [],
    );
  });
});
