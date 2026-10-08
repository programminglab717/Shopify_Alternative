import 'reflect-metadata';
import { PlanAllowance, type PlanLimit, type PlanLimitKind } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toOrder } from './graphql/mappers.js';
import { OVER_LIMIT_MESSAGE } from './plan-orders.js';
import { orderShipmentFactsIn } from './shipment-facts.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

/** A plan of 5 orders a month, or of as many as the shop likes. */
class FivePerMonth extends PlanAllowance {
  unlimited = false;

  async limitOf(_shopId: string, kind: PlanLimitKind): Promise<PlanLimit | null> {
    return this.#limit(kind);
  }

  async limitIn(_tx: unknown, _shopId: string, kind: PlanLimitKind): Promise<PlanLimit | null> {
    return this.#limit(kind);
  }

  async excludes(): Promise<string | null> {
    return null;
  }

  #limit(kind: PlanLimitKind): PlanLimit | null {
    return kind === 'ordersPerMonth' && !this.unlimited ? { limit: 5, plan: 'Free' } : null;
  }
}

describe.skipIf(!server)("Orders past the plan's month (ADR-263)", () => {
  let f: OrdersFixture;
  const plan = new FivePerMonth();
  let chappal: string;

  beforeAll(async () => {
    f = await ordersFixture(server!, { allowance: plan });
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    plan.unlimited = false;
    [chappal] = (await f.variantsOf(f.a, 'Peshawari Chappal', { price: '3,499' })) as [string];
    await f.stock(f.a, chappal, 50);
  });

  const place = async () =>
    unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: chappal, quantity: 1 }],
        shippingAddress: ADDRESS,
        email: 'ayesha@example.com',
      }),
    );
  const counted = async () =>
    (
      await f.admin.query<{ payload: { placed: number; limit: number; plan: string } }>(
        `SELECT payload FROM platform.outbox_events
          WHERE event_type = 'plan_orders.counted' ORDER BY id`,
      )
    ).rows.map((row) => [row.payload.placed, row.payload.limit, row.payload.plan]);

  it('takes every order, those past the limit with their customers hidden and held from staff', async () => {
    const placed = [];
    for (let n = 0; n < 5; n++) placed.push(await place());
    expect(placed.every((order) => order.overLimitAt === null)).toBe(true);
    // The shop is told at 4 of its 5, and at 5.
    expect(await counted()).toEqual([
      [4, 5, 'Free'],
      [5, 5, 'Free'],
    ]);

    const over = await place();
    expect(over.overLimitAt).toBeInstanceOf(Date);
    expect(await counted()).toHaveLength(2);
    const shown = toOrder(over, f.a);
    expect(shown).toMatchObject({ overPlanLimit: true, phone: null, email: null });
    expect(shown.shippingAddress).toMatchObject({
      name: null,
      phone: null,
      address1: null,
      city: over.shippingAddress.city,
    });
    expect(toOrder(placed[0]!, f.a)).toMatchObject({
      overPlanLimit: false,
      email: 'ayesha@example.com',
    });

    // Nothing that works on it or shows its customer, by any way in.
    expect(errorsOf(await f.orders.confirm(f.a, over.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.orders.markPacked(f.a, over.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.orders.revealPhone(f.a, over.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.fulfillments.fulfill(f.a, over.id, {}))).toEqual([['id', 'INVALID']]);
    expect(
      errorsOf(
        await f.documents.render(f.a, [placed[0]!.id, over.id], {
          kind: 'packing_slip',
          paper: 'a4',
          language: 'english',
        }),
      ),
    ).toEqual([['ids', 'INVALID']]);
    const facts = await f.db.tenant(f.a.shopId, (tx) =>
      orderShipmentFactsIn(tx, f.a.shopId, over.id),
    );
    expect(facts?.refusal).toBe(OVER_LIMIT_MESSAGE);
    // Its note and tags are the shop's still.
    unwrap(await f.orders.update(f.a, over.id, { note: 'Call after 6', tags: ['vip'] }));

    // One of the month's counted orders cancelled: the earliest past the limit takes its place.
    const next = await place();
    expect(next.overLimitAt).toBeInstanceOf(Date);
    unwrap(await f.orders.cancel(f.a, placed[1]!.id, { reason: 'customer' }));
    expect((await f.orders.get(f.a, over.id))!.overLimitAt).toBeNull();
    expect((await f.orders.get(f.a, next.id))!.overLimitAt).toBeInstanceOf(Date);
    // Cancelling one past the limit frees nothing.
    const third = await place();
    unwrap(await f.orders.cancel(f.a, third.id, { reason: 'customer' }));
    expect((await f.orders.get(f.a, next.id))!.overLimitAt).toBeInstanceOf(Date);
    unwrap(await f.orders.confirm(f.a, over.id));

    // A plan with room for them frees them all, cancelled ones too, and what is placed on it never
    // counts.
    expect(await f.orders.releaseOverLimit(f.a.shopId)).toBe(2);
    expect((await f.orders.get(f.a, next.id))!.overLimitAt).toBeNull();
    unwrap(await f.orders.confirm(f.a, next.id));
    plan.unlimited = true;
    const free = await place();
    const { rows } = await f.admin.query<{ plan_month: string | null }>(
      'SELECT plan_month FROM orders.orders WHERE id = $1',
      [free.id],
    );
    expect(rows).toEqual([{ plan_month: null }]);
    expect(free.overLimitAt).toBeNull();
    expect(await f.orders.releaseOverLimit(f.a.shopId)).toBe(0);
  });
});
