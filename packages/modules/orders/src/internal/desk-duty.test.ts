import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeskDutyService } from './desk-duty.js';
import type { OrderRecord } from './records.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Agents on duty at the Confirmation Desk (ADR-654)', () => {
  let f: OrdersFixture;
  let duty: DeskDutyService;
  let kurta: string;

  /** A confirmation agent of shop A. */
  const agent = (): TenantContext & { actor: { userId: string } } => ({
    ...f.a,
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      authenticatedAt: new Date(),
      role: 'confirmation_agent',
    },
  });

  /** A cash-on-delivery order waiting to be confirmed, from a number of its own. */
  async function placed(phone: number): Promise<OrderRecord> {
    return unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: { ...ADDRESS, phone: `0300 11133${String(phone).padStart(2, '0')}` },
      }),
    );
  }

  const assigned = async () =>
    (await f.outbox())
      .filter((event) => event.event_type === 'order.assigned')
      .map((event) => [event.aggregate_id, event.payload.assigneeId, event.payload.assignedBy]);

  beforeAll(async () => {
    f = await ordersFixture(server!);
    duty = new DeskDutyService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 100);
  });

  it('shares each order placed among the agents on duty, the fewest waiting first', async () => {
    const [sana, ali] = [agent(), agent()];
    // Agents on duty while the shop shares nothing out: orders stay with no one.
    unwrap(await duty.start(sana, 'Sana', 8));
    expect((await placed(1)).assignee?.staffMemberId ?? null).toBeNull();

    unwrap(await f.orderSettings.update(f.a, { shareNewOrders: true }));
    unwrap(await duty.start(ali, 'Ali', 4));
    await f.admin.query('DELETE FROM platform.outbox_events');
    const [first, second, third] = [await placed(2), await placed(3), await placed(4)];
    // Sana started first; then Ali, who has fewer waiting; then the one given one longest ago.
    expect([first, second, third].map((order) => order.assignee?.staffMemberId ?? null)).toEqual([
      sana.actor.userId,
      ali.actor.userId,
      sana.actor.userId,
    ]);
    // Told as orders given by someone else are, given by no one but the shop's rule.
    expect(await assigned()).toEqual([
      [first.id, sana.actor.userId, null],
      [second.id, ali.actor.userId, null],
      [third.id, sana.actor.userId, null],
    ]);
    const timeline = await f.orders.timeline(f.a, first.id, { first: 10 });
    expect(timeline.items.map((entry) => entry.message)).toContain(
      'Assigned to Sana, on duty at the Confirmation Desk',
    );

    // Who is on duty, the soonest to end first, with how many wait on each.
    expect(
      (await duty.onDuty(f.a)).map((each) => [each.name, each.waiting, each.staffMemberId]),
    ).toEqual([
      ['Ali', 1, ali.actor.userId],
      ['Sana', 2, sana.actor.userId],
    ]);

    // An order confirmed waits on no one; Ali, with none waiting now, is given the next.
    unwrap(await f.orders.confirm(f.a, second.id));
    unwrap(await f.orders.confirm(f.a, third.id));
    expect((await placed(5)).assignee?.staffMemberId ?? null).toBe(ali.actor.userId);

    // Off duty, Ali is given no more; with no one on duty, orders stay with no one.
    await duty.end(ali);
    expect((await placed(6)).assignee?.staffMemberId ?? null).toBe(sana.actor.userId);
    await duty.end(sana);
    expect((await placed(7)).assignee?.staffMemberId ?? null).toBeNull();
    expect(await duty.onDuty(f.a)).toEqual([]);
  });

  it('gives nothing past a shift, nor an order held or placed for someone already', async () => {
    unwrap(await f.orderSettings.update(f.a, { shareNewOrders: true }));
    const sana = agent();
    const started = new Date(Date.now() - 9 * 3_600_000);
    unwrap(await duty.start(sana, 'Sana', 8, started));
    // Her shift ended an hour ago.
    expect((await placed(1)).assignee?.staffMemberId ?? null).toBeNull();
    expect(await duty.onDuty(f.a)).toEqual([]);

    // Starting again starts a new shift; moving its end keeps when it started.
    const again = unwrap(await duty.start(sana, 'Sana', 2));
    const moved = unwrap(await duty.start(sana, 'Sana', 6));
    expect(moved.startedAt).toEqual(again.startedAt);
    expect(moved.endsAt.getTime()).toBeGreaterThan(again.endsAt.getTime());

    // An order held for review needs no call yet.
    unwrap(await f.riskSettings.update(f.a, { highValue: '1,000', holdAt: 0.1 }));
    const held = await placed(2);
    expect(held.stage).not.toBe('needs_confirmation');
    expect(held.assignee).toBeNull();
  });

  it('hands over the orders still waiting on whoever goes off duty, when they ask (ADR-656)', async () => {
    unwrap(await f.orderSettings.update(f.a, { shareNewOrders: true }));
    const [sana, ali, hina] = [agent(), agent(), agent()];
    unwrap(await duty.start(sana, 'Sana', 8));
    const [first, second, third] = [await placed(1), await placed(2), await placed(3)];
    unwrap(await f.orders.confirm(f.a, third.id));
    unwrap(await duty.start(ali, 'Ali', 8));
    unwrap(await duty.start(hina, 'Hina', 8));
    await f.admin.query('DELETE FROM platform.outbox_events');

    // Her two still waiting go one each to Ali and Hina; the confirmed one stays hers.
    expect(await duty.end(sana, { handOver: true })).toBe(2);
    const holders = async (...ids: string[]) =>
      Promise.all(ids.map(async (id) => (await f.orders.get(f.a, id))!.assignee?.staffMemberId));
    expect(await holders(first.id, second.id, third.id)).toEqual([
      ali.actor.userId,
      hina.actor.userId,
      sana.actor.userId,
    ]);
    expect(await assigned()).toEqual([
      [first.id, ali.actor.userId, sana.actor.userId],
      [second.id, hina.actor.userId, sana.actor.userId],
    ]);
    const timeline = await f.orders.timeline(f.a, first.id, { first: 10 });
    expect(timeline.items.map((entry) => entry.message)).toContain(
      'Handed over by Sana to Ali, on duty at the Confirmation Desk',
    );
    expect((await f.orders.get(f.a, first.id))!.version).toBe(first.version + 1);

    // Off duty without asking, or with no one else on duty, orders stay with whoever has them.
    expect(await duty.end(ali)).toBe(0);
    expect(await duty.end(hina, { handOver: true })).toBe(0);
    expect(await holders(first.id, second.id)).toEqual([ali.actor.userId, hina.actor.userId]);
    expect(await duty.end(f.a, { handOver: true })).toBe(0);
  });

  it('hands over by itself what waits on a shift that ran out, where the shop shares orders (ADR-666)', async () => {
    unwrap(await f.orderSettings.update(f.a, { shareNewOrders: true }));
    const [sana, ali] = [agent(), agent()];
    unwrap(await duty.start(sana, 'Sana', 8));
    const [first, second] = [await placed(1), await placed(2)];
    const lapse = (who: { actor: { userId: string } }, hoursAgo: number) =>
      f.admin.query(
        `UPDATE orders.desk_duty SET ends_at = now() - make_interval(hours => $2),
                started_at = now() - make_interval(hours => $2 + 8)
          WHERE staff_member_id = $1`,
        [who.actor.userId, hoursAgo],
      );
    const shifts = async () =>
      (
        await f.admin.query<{ name: string }>('SELECT name FROM orders.desk_duty ORDER BY name')
      ).rows.map((row) => row.name);
    await lapse(sana, 1);

    // No one on duty to take them: they stay hers, and her shift is kept for when someone is.
    expect(await duty.handOverLapsed(f.a.shopId)).toBe(0);
    expect(await shifts()).toEqual(['Sana']);

    // The shop sharing nothing out: nothing moves.
    unwrap(await duty.start(ali, 'Ali', 8));
    unwrap(await f.orderSettings.update(f.a, { shareNewOrders: false }));
    expect(await duty.handOverLapsed(f.a.shopId)).toBe(0);
    unwrap(await f.orderSettings.update(f.a, { shareNewOrders: true }));
    await f.admin.query('DELETE FROM platform.outbox_events');

    // The worker's sweep, across shops.
    expect(await duty.handOverAllLapsed()).toBe(2);
    for (const order of [first, second]) {
      expect((await f.orders.get(f.a, order.id))!.assignee?.staffMemberId).toBe(ali.actor.userId);
    }
    // Told as a shared order is, given by no one but the shop's rule.
    expect(await assigned()).toEqual([
      [first.id, ali.actor.userId, null],
      [second.id, ali.actor.userId, null],
    ]);
    const timeline = await f.orders.timeline(f.a, first.id, { first: 10 });
    expect(timeline.items.map((entry) => entry.message)).toContain(
      'Handed over from Sana, whose shift ended, to Ali, on duty at the Confirmation Desk',
    );
    // Nothing waits on hers any more: it is let go.
    expect(await shifts()).toEqual(['Ali']);

    // A day after it ended, a lapsed shift is let go whatever waits on it.
    const third = await placed(3);
    expect(third.assignee?.staffMemberId).toBe(ali.actor.userId);
    await lapse(ali, 25);
    expect(await duty.handOverLapsed(f.a.shopId)).toBe(0);
    expect(await shifts()).toEqual([]);
    expect((await f.orders.get(f.a, third.id))!.assignee?.staffMemberId).toBe(ali.actor.userId);
  });

  it('keeps shifts to 1 to 12 hours, for members of staff alone, and ends them as they leave', async () => {
    const sana = agent();
    expect(errorsOf(await duty.start(sana, 'Sana', 0))).toEqual([['hours', 'INVALID']]);
    expect(errorsOf(await duty.start(sana, 'Sana', 13))).toEqual([['hours', 'INVALID']]);
    // An app is no member of staff: no order is given to it.
    expect(errorsOf(await duty.start(f.a, 'An app', 8))).toEqual([['hours', 'INVALID']]);

    unwrap(await duty.start(sana, 'Sana', 8));
    expect(await f.orders.release(f.a, sana.actor.userId)).toBe(0);
    expect(await duty.onDuty(f.a)).toEqual([]);
  });
});
