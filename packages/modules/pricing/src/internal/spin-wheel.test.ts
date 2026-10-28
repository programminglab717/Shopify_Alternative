import 'reflect-metadata';
import type { MutationResult, TenantContext } from '@hatti/api';
import { SignUpService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DISCOUNT_CUSTOMER_DATA } from './customer-data.js';
import { DiscountCodeService } from './discount-code.service.js';
import {
  SpinWheelService,
  chooseSlice,
  type SpinOutcome,
  type SpinSliceInput,
} from './spin-wheel.js';

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

function errorsOf(result: MutationResult<unknown> | SpinOutcome | null): [string, string][] {
  if (!result || result.ok) throw new Error('Expected user errors');
  return result.errors.map((error) => [error.field.join('.'), error.code]);
}

function spun(result: SpinOutcome | null): Extract<SpinOutcome, { ok: true }> {
  if (!result?.ok) throw new Error(`Expected a spin, got ${JSON.stringify(result)}`);
  return result;
}

describe('chooseSlice', () => {
  it('stops at each slice about as often as its weight says', () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 6000; i++)
      counts[chooseSlice([{ weight: 1 }, { weight: 2 }, { weight: 3 }])]!++;
    expect(counts[0]).toBeGreaterThan(800);
    expect(counts[0]).toBeLessThan(1200);
    expect(counts[2]).toBeGreaterThan(2700);
    expect(counts[2]).toBeLessThan(3300);
  });
});

describe.skipIf(!server)('SpinWheelService', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let wheels: SpinWheelService;
  let codes: DiscountCodeService;
  const a = tenant(newId());
  const b = tenant(newId());
  let next = 1_000_000;
  const phone = () => `0300${String(next++).padStart(7, '0')}`;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'pricing-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    wheels = new SpinWheelService(db, new SignUpService(db));
    codes = new DiscountCodeService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM pricing.spins; DELETE FROM pricing.spin_wheels; ' +
        'DELETE FROM pricing.discount_codes',
    );
  });

  const turnOn = (
    slices: SpinSliceInput[] = [
      { label: '10% off', kind: 'percentage', percentage: 10, weight: 1 },
      { label: 'Free delivery', kind: 'free_shipping', weight: 1 },
    ],
  ) => wheels.update(a, { enabled: true, slices });

  it('is off until set, and shows no wheel to shoppers', async () => {
    expect(await wheels.get(a)).toMatchObject({
      enabled: false,
      slices: [],
      codeDays: 7,
      minimumSubtotal: null,
      spins: 0,
      codesUsed: 0,
    });
    expect(await wheels.wheel(a.shopId)).toBeNull();
    expect(await wheels.spin(a.shopId, { phone: phone() })).toBeNull();
  });

  it('keeps its slices, checked as codes are', async () => {
    const wheel = unwrap(
      await wheels.update(a, {
        enabled: true,
        slices: [
          { label: ' 10% off ', kind: 'percentage', percentage: 10, weight: 3 },
          { label: 'Rs 500 off', kind: 'amount', amount: '500', weight: 1 },
          { label: 'Free delivery', kind: 'free_shipping', weight: 2 },
          { label: 'Next time', kind: 'none', weight: 4 },
        ],
        codeDays: 3,
        minimumSubtotal: '2,000',
      }),
    );
    expect(wheel).toMatchObject({
      enabled: true,
      codeDays: 3,
      minimumSubtotal: 200_000n,
      slices: [
        { label: '10% off', kind: 'percentage', percentage: 10, amount: null, weight: 3 },
        { label: 'Rs 500 off', kind: 'amount', percentage: null, amount: 50_000n, weight: 1 },
        { label: 'Free delivery', kind: 'free_shipping', weight: 2 },
        { label: 'Next time', kind: 'none', weight: 4 },
      ],
    });
    expect(await wheels.wheel(a.shopId)).toEqual({
      slices: [
        { label: '10% off' },
        { label: 'Rs 500 off' },
        { label: 'Free delivery' },
        { label: 'Next time' },
      ],
    });
    // Another shop's wheel is its own.
    expect(await wheels.wheel(b.shopId)).toBeNull();
    // Left out, the rest stays.
    expect(unwrap(await wheels.update(a, { enabled: false }))).toMatchObject({
      enabled: false,
      codeDays: 3,
      minimumSubtotal: 200_000n,
    });
    expect(await wheels.wheel(a.shopId)).toBeNull();
  });

  it('refuses slices that cannot be codes, and a wheel on without slices', async () => {
    expect(
      errorsOf(
        await wheels.update(a, {
          slices: [
            { label: '', kind: 'percentage', percentage: 150, weight: 0 },
            { label: 'Rs off', kind: 'amount', amount: 'lots', weight: 1 },
          ],
          codeDays: 0,
          minimumSubtotal: '0',
        }),
      ),
    ).toEqual([
      ['slices.0.label', 'BLANK'],
      ['slices.0.weight', 'INVALID'],
      ['slices.0.percentage', 'INVALID'],
      ['slices.1.amount', 'INVALID'],
      ['codeDays', 'INVALID'],
      ['minimumSubtotal', 'INVALID'],
    ]);
    expect(
      errorsOf(await wheels.update(a, { slices: [{ label: 'Only', kind: 'none', weight: 1 }] })),
    ).toEqual([['slices', 'INVALID']]);
    expect(errorsOf(await wheels.update(a, { enabled: true }))).toEqual([['slices', 'BLANK']]);
    expect((await wheels.get(a)).enabled).toBe(false);
  });

  it('signs the shopper up and gives them a code of their own, once a number', async () => {
    unwrap(
      await turnOn([
        { label: '10% off', kind: 'percentage', percentage: 10, weight: 1 },
        { label: '15% off', kind: 'percentage', percentage: 15, weight: 1 },
      ]),
    );
    unwrap(await wheels.update(a, { minimumSubtotal: '1500', codeDays: 2 }));
    const number = phone();
    const before = Date.now();
    const first = spun(await wheels.spin(a.shopId, { phone: number }));
    expect(first).toMatchObject({ again: false });
    expect(['10% off', '15% off'][first.slice]).toBe(first.label);
    expect(first.code).toMatch(/^SPIN-[A-HJ-NP-Z2-9]{8}$/);
    expect(first.endsAt!.getTime()).toBeGreaterThanOrEqual(before + 2 * 86_400_000);
    const code = await codes.byCode(a, first.code!);
    expect(code).toMatchObject({
      title: `Spin to win: ${first.label}`,
      kind: 'percentage',
      percentageBps: first.slice === 0 ? 1000 : 1500,
      minimumSubtotal: 150_000n,
      usageLimit: 1,
      oncePerCustomer: true,
    });

    // Signed up for the shop's news, tagged.
    const { rows } = await admin.query(
      `SELECT tags, whatsapp_consent FROM customers.customers
        WHERE shop_id = $1 AND phone = $2`,
      [a.shopId, `+92${number.slice(1)}`],
    );
    expect(rows).toEqual([{ tags: ['spin'], whatsapp_consent: 'subscribed' }]);

    // Again, in any form of the number: the same.
    const again = spun(await wheels.spin(a.shopId, { phone: `+92 ${number.slice(1)}` }));
    expect(again).toEqual({ ...first, again: true });
    expect((await wheels.get(a)).spins).toBe(1);
  });

  it('gives nothing for a slice that gives nothing', async () => {
    unwrap(
      await wheels.update(a, {
        enabled: true,
        slices: [
          { label: 'Next time', kind: 'none', weight: 1 },
          { label: 'So close', kind: 'none', weight: 1 },
        ],
      }),
    );
    expect(spun(await wheels.spin(a.shopId, { phone: phone() }))).toMatchObject({
      code: null,
      endsAt: null,
      again: false,
    });
    expect((await codes.list(a, { first: 5 })).items).toEqual([]);
  });

  it('refuses a number that is no mobile', async () => {
    unwrap(await turnOn());
    expect(errorsOf(await wheels.spin(a.shopId, { phone: '123' }))).toEqual([['phone', 'INVALID']]);
    expect(errorsOf(await wheels.spin(a.shopId, { phone: '' }))).toEqual([['phone', 'BLANK']]);
  });

  it('answers two spins of a number at once with one slice and code', async () => {
    unwrap(await turnOn());
    const number = phone();
    const [one, two] = await Promise.all([
      wheels.spin(a.shopId, { phone: number }),
      wheels.spin(a.shopId, { phone: number }),
    ]);
    expect(spun(one).code).toBe(spun(two).code);
    expect([spun(one).again, spun(two).again].sort()).toEqual([false, true]);
  });

  it("goes with the customer's erasure, and is in their export", async () => {
    unwrap(await turnOn());
    const number = phone();
    const made = spun(await wheels.spin(a.shopId, { phone: number }));
    const customer = { id: newId(), phones: [`+92${number.slice(1)}`], email: null };
    const exported = await db.tenant(a.shopId, (tx) =>
      DISCOUNT_CUSTOMER_DATA.export(tx, a.shopId, customer),
    );
    expect(exported.wheelSpins).toEqual([
      { slice: made.label, code: made.code, spunAt: expect.any(Date) },
    ]);
    await db.tenant(a.shopId, (tx) =>
      DISCOUNT_CUSTOMER_DATA.erase(tx, a.shopId, customer, 'system'),
    );
    expect((await wheels.get(a)).spins).toBe(0);
  });
});
