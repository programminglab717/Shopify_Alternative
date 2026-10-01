import 'reflect-metadata';
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DISCOUNT_CUSTOMER_DATA } from './customer-data.js';
import { DiscountCodeService, type DiscountCodeInput } from './discount-code.service.js';
import { DISCOUNT_CODE_LIMIT } from './discounts.js';
import { applyDiscountIn, redeemDiscountIn } from './redemptions.js';
import { discountCodes, discountRedemptions } from './schema.js';

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

describe.skipIf(!server)('DiscountCodeService', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let codes: DiscountCodeService;
  const a = tenant(newId());
  const b = tenant(newId());

  const create = (input: DiscountCodeInput, owner = a) => codes.create(owner, input);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'pricing-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    codes = new DiscountCodeService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM pricing.discount_redemptions; DELETE FROM pricing.discount_codes; ' +
        'DELETE FROM platform.outbox_events',
    );
  });

  it('matches the migrated tables', async () => {
    await db.tenant(a.shopId, async (tx) => {
      for (const table of [discountCodes, discountRedemptions])
        await tx.select().from(table).limit(1);
    });
  });

  it('makes codes for a percentage or an amount off, or free delivery', async () => {
    const before = Date.now();
    const eid = unwrap(await create({ code: ' EID25 ', percentage: 25 }));
    expect(eid).toMatchObject({
      code: 'EID25',
      title: 'EID25',
      kind: 'percentage',
      percentageBps: 2_500,
      amount: null,
      minimumSubtotal: null,
      endsAt: null,
      usageLimit: null,
      oncePerCustomer: false,
      used: 0,
      version: 1,
    });
    expect(eid.startsAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);

    const ends = new Date('2026-12-31T23:59:59+05:00');
    const save = unwrap(
      await create({
        code: 'SAVE-500',
        title: 'Rs 500 off for WhatsApp customers',
        amount: '500',
        minimumSubtotal: '3,000',
        startsAt: new Date('2026-10-01T00:00:00+05:00'),
        endsAt: ends,
        usageLimit: 100,
        oncePerCustomer: true,
      }),
    );
    expect(save).toMatchObject({
      kind: 'fixed_amount',
      percentageBps: null,
      amount: 500_00n,
      minimumSubtotal: 3_000_00n,
      endsAt: ends,
      usageLimit: 100,
      oncePerCustomer: true,
    });
    const free = unwrap(await create({ code: 'free_delivery', freeShipping: true }));
    expect(free).toMatchObject({ kind: 'free_shipping', percentageBps: null, amount: null });

    const { rows } = await admin.query<{ event_type: string; payload: unknown }>(
      'SELECT event_type, payload FROM platform.outbox_events ORDER BY occurred_at, id',
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'discount_code.created',
      'discount_code.created',
      'discount_code.created',
    ]);
    expect(rows[0]!.payload).toEqual({ code: 'EID25', kind: 'percentage', version: 1 });
  });

  it('checks what a code gives and when', async () => {
    expect(errorsOf(await create({ percentage: 10 }))).toEqual([['code', 'BLANK']]);
    expect(errorsOf(await create({ code: 'EID 25', percentage: 10 }))).toEqual([
      ['code', 'INVALID'],
    ]);
    expect(errorsOf(await create({ code: 'EID25' }))).toEqual([['percentage', 'BLANK']]);
    expect(errorsOf(await create({ code: 'EID25', percentage: 10, amount: '500' }))).toEqual([
      ['amount', 'INVALID'],
    ]);
    for (const percentage of [0, -5, 100.5, 12.345]) {
      expect(errorsOf(await create({ code: 'EID25', percentage })), String(percentage)).toEqual([
        ['percentage', 'INVALID'],
      ]);
    }
    expect(unwrap(await create({ code: 'HALF', percentage: 12.5 })).percentageBps).toBe(1_250);
    expect(errorsOf(await create({ code: 'ZERO', amount: '0' }))).toEqual([['amount', 'INVALID']]);
    expect(errorsOf(await create({ code: 'NEG', amount: '-5' }))).toEqual([['amount', 'INVALID']]);
    expect(
      errorsOf(await create({ code: 'MIN', freeShipping: true, minimumSubtotal: '0' })),
    ).toEqual([['minimumSubtotal', 'INVALID']]);
    const starts = new Date('2026-10-10T00:00:00+05:00');
    expect(
      errorsOf(await create({ code: 'LATE', percentage: 5, startsAt: starts, endsAt: starts })),
    ).toEqual([['endsAt', 'INVALID']]);
    for (const usageLimit of [0, 1_000_001, 1.5]) {
      expect(errorsOf(await create({ code: 'USES', percentage: 5, usageLimit }))).toEqual([
        ['usageLimit', 'INVALID'],
      ]);
    }
  });

  it('keeps a code once in a shop, in any letter case, and another shop may have it', async () => {
    unwrap(await create({ code: 'EID25', percentage: 25 }));
    expect(errorsOf(await create({ code: 'eid25', percentage: 10 }))).toEqual([['code', 'TAKEN']]);
    expect(unwrap(await create({ code: 'eid25', percentage: 10 }, b)).code).toBe('eid25');
    expect((await codes.byCode(a, ' Eid25 '))?.code).toBe('EID25');
    expect(await codes.byCode(a, 'NONE')).toBeNull();
  });

  it('changes what is given and leaves the rest, and deletes codes', async () => {
    const eid = unwrap(
      await create({ code: 'EID25', percentage: 25, minimumSubtotal: '2,000', usageLimit: 50 }),
    );
    // Nothing changed: no new version.
    expect(unwrap(await codes.update(a, eid.id, { percentage: 25 })).version).toBe(1);
    const amount = unwrap(await codes.update(a, eid.id, { amount: '300', title: 'Eid' }));
    expect(amount).toMatchObject({
      code: 'EID25',
      title: 'Eid',
      kind: 'fixed_amount',
      percentageBps: null,
      amount: 300_00n,
      minimumSubtotal: 2_000_00n,
      usageLimit: 50,
      version: 2,
    });
    const cleared = unwrap(
      await codes.update(a, eid.id, { minimumSubtotal: null, usageLimit: null, title: null }),
    );
    expect(cleared).toMatchObject({ minimumSubtotal: null, usageLimit: null, title: 'EID25' });
    // The end must still come after the start the code has.
    expect(errorsOf(await codes.update(a, eid.id, { endsAt: new Date(0) }))).toEqual([
      ['endsAt', 'INVALID'],
    ]);
    unwrap(await create({ code: 'SAVE', freeShipping: true }));
    expect(errorsOf(await codes.update(a, eid.id, { code: 'save' }))).toEqual([['code', 'TAKEN']]);
    expect(errorsOf(await codes.update(b, eid.id, { percentage: 5 }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);

    expect(errorsOf(await codes.delete(b, eid.id))).toEqual([['id', 'NOT_FOUND']]);
    unwrap(await codes.delete(a, eid.id));
    expect(await codes.get(a, eid.id)).toBeNull();
    const { rows } = await admin.query<{ event_type: string }>(
      'SELECT event_type FROM platform.outbox_events ORDER BY occurred_at, id',
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'discount_code.created',
      'discount_code.updated',
      'discount_code.updated',
      'discount_code.created',
      'discount_code.deleted',
    ]);
  });

  it('lists codes newest first, a page at a time, and finds them by code or title', async () => {
    for (const code of ['EID25', 'SAVE-500', 'FREEDEL']) {
      unwrap(await create({ code, title: `${code} for Eid`, freeShipping: true }));
    }
    const first = await codes.list(a, { first: 2 });
    expect(first.items.map((code) => code.code)).toEqual(['FREEDEL', 'SAVE-500']);
    expect(first.hasNextPage).toBe(true);
    const next = await codes.list(a, { first: 2, after: first.items[1]!.id });
    expect(next).toMatchObject({ items: [{ code: 'EID25' }], hasNextPage: false });
    expect((await codes.list(a, { first: 10, query: 'save' })).items).toHaveLength(1);
    expect((await codes.list(a, { first: 10, query: 'for eid' })).items).toHaveLength(3);
    expect((await codes.list(a, { first: 10, query: '100%' })).items).toHaveLength(0);
    expect((await codes.list(b, { first: 10 })).items).toEqual([]);
  });

  it(`keeps ${DISCOUNT_CODE_LIMIT.toLocaleString('en')} codes a shop at most`, async () => {
    await admin.query(
      `INSERT INTO pricing.discount_codes (shop_id, id, code, title, kind, percentage_bps)
       SELECT $1, gen_random_uuid(), 'C' || n, 'C' || n, 'percentage', 500
         FROM generate_series(1, $2::int) n`,
      [a.shopId, DISCOUNT_CODE_LIMIT],
    );
    expect(errorsOf(await create({ code: 'ONEMORE', percentage: 5 }))).toEqual([['', 'TOO_MANY']]);
    unwrap(await create({ code: 'ONEMORE', percentage: 5 }, b));
  });

  it('puts a code to an order by its dates, minimum and uses, in any letter case', async () => {
    const order = { subtotal: 4_000_00n, shipping: 250_00n };
    const apply = (code: string, at?: Date, owner = a) =>
      db.tenant(owner.shopId, (tx) => applyDiscountIn(tx, owner.shopId, code, order, at));
    const starts = new Date('2026-10-05T00:00:00+05:00');
    unwrap(
      await create({
        code: 'EID25',
        percentage: 25,
        minimumSubtotal: '3,000',
        startsAt: starts,
        endsAt: new Date('2026-10-08T00:00:00+05:00'),
      }),
    );
    const during = new Date('2026-10-06T12:00:00+05:00');
    expect(await apply(' eid25 ', during)).toMatchObject({
      ok: true,
      code: { code: 'EID25' },
      amounts: { items: 1_000_00n, shipping: 0n },
    });
    expect(await apply('EID25', new Date('2026-10-04T00:00:00+05:00'))).toEqual({
      ok: false,
      refusal: { reason: 'scheduled', startsAt: starts },
    });
    expect(await apply('EID25', new Date('2026-10-08T00:00:00+05:00'))).toEqual({
      ok: false,
      refusal: { reason: 'expired' },
    });
    const small = await db.tenant(a.shopId, (tx) =>
      applyDiscountIn(tx, a.shopId, 'EID25', { subtotal: 2_999_00n, shipping: 0n }, during),
    );
    expect(small).toEqual({ ok: false, refusal: { reason: 'minimum', minimum: 3_000_00n } });
    for (const typed of ['NOPE', 'EID 25', '']) {
      expect(await apply(typed, during), typed).toEqual({
        ok: false,
        refusal: { reason: 'unknown' },
      });
    }
    expect(await apply('EID25', during, b)).toEqual({ ok: false, refusal: { reason: 'unknown' } });
    unwrap(await create({ code: 'FREE', freeShipping: true }));
    expect(await apply('free')).toMatchObject({
      ok: true,
      amounts: { items: 0n, shipping: 250_00n },
    });
  });

  it('counts a use with each order, refusing one past the limit or a second by a customer', async () => {
    const twice = unwrap(await create({ code: 'TWICE', amount: '500', usageLimit: 2 }));
    const once = unwrap(await create({ code: 'ONCE', amount: '300', oncePerCustomer: true }));
    const [ayesha, bilal] = [newId(), newId()];
    const redeem = (codeId: string, customerId: string) =>
      db.tenant(a.shopId, (tx) =>
        redeemDiscountIn(tx, a.shopId, { codeId, orderId: newId(), customerId, amount: 500_00n }),
      );
    expect(await redeem(twice.id, ayesha)).toEqual({ ok: true });
    expect(await redeem(twice.id, ayesha)).toEqual({ ok: true });
    expect(await redeem(twice.id, bilal)).toEqual({ ok: false, refusal: { reason: 'used_up' } });
    expect((await codes.get(a, twice.id))?.used).toBe(2);
    const order = { subtotal: 1_000_00n, shipping: 0n };
    expect(
      await db.tenant(a.shopId, (tx) => applyDiscountIn(tx, a.shopId, 'TWICE', order)),
    ).toEqual({ ok: false, refusal: { reason: 'used_up' } });

    expect(await redeem(once.id, ayesha)).toEqual({ ok: true });
    expect(await redeem(once.id, ayesha)).toEqual({ ok: false, refusal: { reason: 'used' } });
    expect(await redeem(once.id, bilal)).toEqual({ ok: true });
    // Merged into Bilal, Ayesha's use is his: a third customer still may.
    const carim = newId();
    expect(await redeem(once.id, carim)).toEqual({ ok: true });
    await db.tenant(a.shopId, (tx) => DISCOUNT_CUSTOMER_DATA.merge(tx, a.shopId, carim, bilal));
    const { rows } = await admin.query<{ customer_id: string }>(
      'SELECT customer_id FROM pricing.discount_redemptions WHERE code_id = $1',
      [once.id],
    );
    expect(rows.map((row) => row.customer_id).sort()).toEqual([ayesha, bilal, bilal].sort());
    // A customer's own file lists their uses, oldest first, each with the order it was on.
    const exported = (shopId: string, customerId: string) =>
      db.tenant(shopId, (tx) =>
        DISCOUNT_CUSTOMER_DATA.export(tx, shopId, { id: customerId, phones: [], email: null }),
      );
    const use = (code: string) => ({
      code,
      orderId: expect.stringMatching(/^ord_/) as string,
      usedAt: expect.any(Date) as Date,
    });
    expect(await exported(a.shopId, ayesha)).toEqual({
      discountCodeUses: [use('TWICE'), use('TWICE'), use('ONCE')],
    });
    expect(await exported(b.shopId, ayesha)).toEqual({ discountCodeUses: [] });
    const events = await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM platform.outbox_events
        WHERE event_type = 'discount_code.redeemed' ORDER BY occurred_at, id`,
    );
    expect(events.rows).toHaveLength(5);
    expect(events.rows[0]!.payload).toMatchObject({ code: 'TWICE', amount: '50000' });
  });
});
