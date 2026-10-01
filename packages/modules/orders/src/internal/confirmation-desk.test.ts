import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfirmationDeskService } from './confirmation-desk.service.js';
import type { OrderRecord } from './records.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('ConfirmationDeskService', () => {
  let f: OrdersFixture;
  let desk: ConfirmationDeskService;
  let kurta: string;

  /** A confirmation agent of shop A. */
  const agent = (): TenantContext => ({
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
  async function waiting(units = 1, phone = 1): Promise<OrderRecord> {
    return unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: units }],
        shippingAddress: { ...ADDRESS, phone: `0300 11122${String(phone).padStart(2, '0')}` },
      }),
    );
  }

  const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  beforeAll(async () => {
    f = await ordersFixture(server!);
    desk = new ConfirmationDeskService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 100);
    // Rs 5,000 and more is high value here.
    unwrap(await f.riskSettings.update(f.a, { highValue: '5,000' }));
  });

  it('deals agents the most urgent order due, one each, never one to two', async () => {
    const first = await waiting(1, 1);
    const big = await waiting(3, 2);
    const third = await waiting(1, 3);
    const confirmed = await waiting(1, 4);
    unwrap(await f.orders.confirm(f.a, confirmed.id));

    // High value first, then as they fell due; the confirmed one is out.
    const queue = await desk.queue(f.a, { first: 10 });
    expect(queue.items.map((item) => item.order.id)).toEqual([big.id, first.id, third.id]);
    expect(queue).toMatchObject({ dueCount: 3, laterCount: 0 });
    expect(queue.items[0]).toMatchObject({
      unansweredCalls: 0,
      dueAt: big.createdAt,
      lastCall: null,
      claimedUntil: null,
      claimedByCaller: false,
    });

    const [ali, sana] = [agent(), agent()];
    const dealt = await desk.next(ali);
    expect(dealt).toMatchObject({ order: { id: big.id }, claimedByCaller: true });
    expect(dealt!.claimedUntil!.getTime()).toBeGreaterThan(later(14).getTime());
    expect((await desk.next(sana))?.order.id).toBe(first.id);
    // Asked again, an agent keeps the one they have.
    expect((await desk.next(ali))?.order.id).toBe(big.id);
    // Two at once get one each.
    const both = await Promise.all([desk.next(agent()), desk.next(agent())]);
    expect(both.map((item) => item?.order.id ?? null).sort()).toEqual([third.id, null].sort());

    // The queue says who has what; each sees their own.
    const seen = await desk.queue(ali, { first: 10 });
    expect(seen.items.map((item) => [item.order.id, item.claimedByCaller])).toEqual([
      [big.id, true],
      [first.id, false],
      [third.id, false],
    ]);
    expect(seen.items.every((item) => item.claimedUntil !== null)).toBe(true);
    // Once a claim runs out, the order goes to whoever asks.
    expect((await desk.next(agent(), later(16)))?.order.id).toBe(big.id);

    // Taking an order changes nothing of it.
    expect((await f.orders.get(f.a, big.id))!.version).toBe(big.version);
    expect((await desk.queue(f.b, { first: 10 })).items).toEqual([]);
    expect(await desk.next({ ...f.b, actor: ali.actor })).toBeNull();
  });

  it('records calls: unanswered, due again; asked to call back, due then; a wrong number, held', async () => {
    const order = await waiting(1, 1);
    const ali = agent();
    await desk.next(ali);
    await f.admin.query('DELETE FROM platform.outbox_events');

    // No answer: due again in two hours, and let go.
    const now = new Date();
    const missed = unwrap(
      await desk.recordCall(ali, order.id, { outcome: 'no_answer', note: 'Phone off' }, now),
    );
    expect(missed).toMatchObject({ confirmationStatus: 'pending', stage: 'needs_confirmation' });
    let queue = await desk.queue(f.a, { first: 10, at: now });
    expect(queue).toMatchObject({ items: [], dueCount: 0, laterCount: 1 });
    queue = await desk.queue(f.a, { first: 10, at: new Date(now.getTime() + 121 * 60_000) });
    expect(queue.items[0]).toMatchObject({
      unansweredCalls: 1,
      dueAt: new Date(now.getTime() + 120 * 60_000),
      lastCall: { outcome: 'no_answer', note: 'Phone off', callBackAt: null },
      claimedUntil: null,
    });

    // Three unanswered: the customer could not be reached, and is still called.
    for (const minutes of [130, 260]) {
      const at = new Date(now.getTime() + minutes * 60_000);
      unwrap(await desk.recordCall(ali, order.id, { outcome: 'no_answer' }, at));
    }
    const unreachable = (await f.orders.get(f.a, order.id))!;
    expect(unreachable).toMatchObject({
      confirmationStatus: 'no_response',
      stage: 'needs_confirmation',
    });
    const timeline = await f.orders.timeline(f.a, order.id, { first: 3 });
    expect(timeline.items.map((entry) => entry.message)).toEqual([
      'Called, no answer (3 unanswered): the customer could not be reached',
      'Called, no answer (2 unanswered)',
      'Called, no answer (1 unanswered)',
    ]);

    // Asked to call back: due then, not before; within a week.
    const back = new Date(now.getTime() + 26 * 3_600_000);
    expect(errorsOf(await desk.recordCall(ali, order.id, { outcome: 'call_back' }, now))).toEqual([
      ['callBackAt', 'BLANK'],
    ]);
    for (const callBackAt of [new Date(now.getTime() - 60_000), later(8 * 24 * 60)]) {
      expect(
        errorsOf(await desk.recordCall(ali, order.id, { outcome: 'call_back', callBackAt }, now)),
      ).toEqual([['callBackAt', 'INVALID']]);
    }
    unwrap(
      await desk.recordCall(
        ali,
        order.id,
        { outcome: 'call_back', callBackAt: back, note: 'After her shift' },
        now,
      ),
    );
    expect((await desk.queue(f.a, { first: 10, at: back })).items[0]).toMatchObject({
      dueAt: back,
      unansweredCalls: 3,
      lastCall: { outcome: 'call_back', callBackAt: back, note: 'After her shift' },
    });
    // The note stays with the call: the timeline says how it went.
    expect((await f.orders.timeline(f.a, order.id, { first: 1 })).items[0]!.message).toBe(
      'Called: the customer asked to be called back',
    );

    // A wrong number holds the order for review, out of the queue.
    const wrong = await waiting(1, 2);
    const held = unwrap(await desk.recordCall(ali, wrong.id, { outcome: 'wrong_number' }, now));
    expect(held).toMatchObject({ confirmationStatus: 'needs_review', stage: 'needs_review' });
    expect(
      (await desk.queue(f.a, { first: 10, at: back })).items.map((item) => item.order.id),
    ).toEqual([order.id]);
    const events = (await f.outbox()).map((event) => event.payload.changed);
    expect(events).toContainEqual(['confirmationCall']);
    expect(events).toContainEqual(['confirmationCall', 'confirmationStatus']);

    // Only orders waiting to be confirmed take calls, and only the shop's own.
    unwrap(await f.orders.confirm(f.a, order.id));
    expect(errorsOf(await desk.recordCall(ali, order.id, { outcome: 'no_answer' }))).toEqual([
      ['id', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await desk.recordCall({ ...f.b, actor: ali.actor }, wrong.id, { outcome: 'no_answer' }),
      ),
    ).toEqual([['id', 'NOT_FOUND']]);
    expect(
      errorsOf(
        await desk.recordCall(ali, wrong.id, { outcome: 'no_answer', note: 'x'.repeat(501) }),
      ),
    ).toEqual([['note', 'TOO_LONG']]);
  });

  /** A moment in Karachi. */
  const pkt = (time: string) => new Date(`2026-10-${time}+05:00`);

  it("keeps the shop's calling hours, and an unanswered order falls due again within them", async () => {
    unwrap(
      await f.orderSettings.update(f.a, { callingHours: { opens: '10:00', closes: '21:00' } }),
    );
    const order = await waiting(1, 1);
    const ali = agent();
    // Before they open, the queue lists the order but deals nothing, and says when they open.
    const early = pkt('02T08:00:00');
    expect(await desk.next(ali, early)).toBeNull();
    expect(await desk.calling(f.a, early)).toEqual({
      callingNow: false,
      opensAt: pkt('02T10:00:00'),
    });
    expect(await desk.queue(f.a, { first: 10, at: early })).toMatchObject({
      callingNow: false,
      opensAt: pkt('02T10:00:00'),
      dueCount: 1,
      items: [{ order: { id: order.id } }],
    });
    // Open, it is dealt; unanswered at 20:30, two hours on is after they close: due at opening.
    const evening = pkt('02T20:30:00');
    expect((await desk.next(ali, evening))?.order.id).toBe(order.id);
    unwrap(await desk.recordCall(ali, order.id, { outcome: 'no_answer' }, evening));
    const dueAt = async (at: Date) =>
      (await desk.queue(f.a, { first: 10, at })).items[0]?.dueAt ?? null;
    expect(await dueAt(pkt('03T09:59:00'))).toBeNull();
    expect(await dueAt(pkt('03T10:00:00'))).toEqual(pkt('03T10:00:00'));
    // In the afternoon, two hours on as before.
    unwrap(await desk.recordCall(ali, order.id, { outcome: 'no_answer' }, pkt('03T14:00:00')));
    expect(await dueAt(pkt('03T16:00:00'))).toEqual(pkt('03T16:00:00'));
    // A time the customer asked for stands, whatever the hours.
    unwrap(
      await desk.recordCall(
        ali,
        order.id,
        { outcome: 'call_back', callBackAt: pkt('03T22:00:00') },
        pkt('03T16:05:00'),
      ),
    );
    expect(await dueAt(pkt('03T22:00:00'))).toEqual(pkt('03T22:00:00'));
    // Without hours, any time.
    unwrap(await f.orderSettings.update(f.a, { callingHours: null }));
    expect(await desk.calling(f.a, early)).toEqual({ callingNow: true, opensAt: null });
    expect((await desk.next(ali, pkt('03T23:00:00')))?.order.id).toBe(order.id);
  });

  it('says which orders waited too long for their first call, counting calling hours', async () => {
    unwrap(
      await f.orderSettings.update(f.a, {
        callingHours: { opens: '10:00', closes: '21:00' },
        firstCallMinutes: 30,
      }),
    );
    const [beforeOpening, lateEvening, called] = [
      await waiting(1, 1),
      await waiting(1, 2),
      await waiting(1, 3),
    ];
    const placedAt = (id: string, at: string) =>
      f.admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [id, pkt(at)]);
    await placedAt(beforeOpening.id, '02T09:00:00');
    await placedAt(lateEvening.id, '02T20:50:00');
    await placedAt(called.id, '02T09:00:00');
    unwrap(
      await desk.recordCall(
        agent(),
        called.id,
        { outcome: 'call_back', callBackAt: pkt('03T10:05:00') },
        pkt('02T10:01:00'),
      ),
    );
    const overdue = async (at: Date) => {
      const queue = await desk.queue(f.a, { first: 10, at });
      return {
        count: queue.overdueCount,
        items: queue.items.map((item) => [item.order.id, item.overdue]),
      };
    };
    // At 10:15 the next morning: one has waited all of yesterday's hours, the other 25 minutes
    // of them; the third is no longer waiting for its first call.
    expect(await overdue(pkt('03T10:15:00'))).toEqual({
      count: 1,
      items: [
        [beforeOpening.id, true],
        [lateEvening.id, false],
        [called.id, false],
      ],
    });
    // Ten minutes on, 35.
    expect((await overdue(pkt('03T10:25:00'))).count).toBe(2);
    // Without hours, by the clock; without a target, none.
    unwrap(await f.orderSettings.update(f.a, { callingHours: null }));
    expect((await overdue(pkt('02T21:15:00'))).count).toBe(1);
    unwrap(await f.orderSettings.update(f.a, { firstCallMinutes: null }));
    expect(await overdue(pkt('03T10:25:00'))).toMatchObject({ count: 0 });
  });

  it('cancels the orders whose customers could not be reached, as many days on as the shop says', async () => {
    const ali = agent();
    /** An order whose customer did not answer three calls. */
    const unreachable = async (phone: number) => {
      const order = await waiting(1, phone);
      for (let call = 0; call < 3; call++) {
        unwrap(await desk.recordCall(ali, order.id, { outcome: 'no_answer' }));
      }
      return order;
    };
    const old = await unreachable(1);
    const recent = await unreachable(2);
    const answered = await waiting(1, 3);
    const reached = await unreachable(4);
    unwrap(await f.orders.confirm(ali, reached.id));
    await f.admin.query(
      `UPDATE orders.orders SET created_at = now() - interval '5 days' WHERE id = ANY($1::uuid[])`,
      [[old.id, answered.id, reached.id]],
    );
    const committed = async () => (await f.level(f.a, kurta))!.committed;
    const before = await committed();
    await f.admin.query('DELETE FROM platform.outbox_events');

    // Placed five days ago and never answered: cancelled, its stock let go.
    expect(await f.orders.cancelUnreachable(f.a.shopId, 3)).toBe(1);
    expect(await f.orders.get(f.a, old.id)).toMatchObject({
      status: 'cancelled',
      stage: 'cancelled',
      cancelReason: 'no_response',
    });
    expect((await f.orders.timeline(f.a, old.id, { first: 1 })).items[0]).toMatchObject({
      kind: 'cancelled',
      message: 'Cancelled: the customer could not be reached in 3 days',
    });
    expect(await committed()).toBe(before - 1);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type.startsWith('order.'))
        .map((event) => [event.event_type, event.payload.reason]),
    ).toEqual([['order.cancelled', 'no_response']]);
    // Placed lately, still waiting to be called, or reached and confirmed since: as they were.
    for (const order of [recent, answered, reached]) {
      expect((await f.orders.get(f.a, order.id))!.status).toBe('open');
    }
    // Swept again, nothing more; another shop has none.
    expect(await f.orders.cancelUnreachable(f.a.shopId, 3)).toBe(0);
    expect(await f.orders.cancelUnreachable(f.b.shopId, 1)).toBe(0);
    // A day's wait takes the recent one too, once a day has passed.
    expect(
      await f.orders.cancelUnreachable(f.a.shopId, 1, new Date(Date.now() + 86_400_000 + 60_000)),
    ).toBe(1);
    expect((await f.orders.get(f.a, recent.id))!.status).toBe('cancelled');
  });

  it("checks the shop's calling hours and first-call target, and records each change", async () => {
    const errors = async (input: Parameters<typeof f.orderSettings.update>[1]) => {
      const result = await f.orderSettings.update(f.a, input);
      return result.ok
        ? []
        : result.errors.map((error) => [error.field.join('.'), error.code, error.message]);
    };
    expect(await errors({ callingHours: { opens: '10', closes: '25:00' } })).toEqual([
      ['input.callingHours.opens', 'INVALID', 'Give a time of day, like 10:00'],
      ['input.callingHours.closes', 'INVALID', 'Give a time of day, like 21:00'],
    ]);
    expect(await errors({ callingHours: { opens: '21:00', closes: '21:30' } })).toEqual([
      [
        'input.callingHours',
        'INVALID',
        'Calling hours close at least an hour after they open, on the same day',
      ],
    ]);
    expect(await errors({ cancelUnreachableAfterDays: 0 })).toEqual([
      [
        'input.cancelUnreachableAfterDays',
        'INVALID',
        'Cancel unreachable after days must be a whole number from 1 to 30',
      ],
    ]);
    expect(
      unwrap(await f.orderSettings.update(f.a, { cancelUnreachableAfterDays: 3 })),
    ).toMatchObject({ cancelUnreachableAfterDays: 3 });
    expect(await errors({ firstCallMinutes: 4 })).toEqual([
      [
        'input.firstCallMinutes',
        'INVALID',
        'First call minutes must be a whole number from 5 to 1440',
      ],
    ]);
    await f.admin.query('DELETE FROM platform.outbox_events');
    expect(
      unwrap(
        await f.orderSettings.update(f.a, {
          callingHours: { opens: '9:30', closes: '24:00' },
          firstCallMinutes: 45,
        }),
      ),
    ).toMatchObject({ callingHours: { opens: 570, closes: 1440 }, firstCallMinutes: 45 });
    // The same again changes nothing; null takes them away.
    unwrap(
      await f.orderSettings.update(f.a, { callingHours: { opens: '09:30', closes: '24:00' } }),
    );
    expect(
      unwrap(await f.orderSettings.update(f.a, { callingHours: null, firstCallMinutes: null })),
    ).toMatchObject({
      callingHours: null,
      firstCallMinutes: null,
      customerCancellation: 'until_packed',
    });
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'order_settings.updated')
        .map((event) => [event.payload.callingHours, event.payload.firstCallMinutes]),
    ).toEqual([
      [{ opens: '09:30', closes: '24:00' }, 45],
      [null, null],
    ]);
  });
});
