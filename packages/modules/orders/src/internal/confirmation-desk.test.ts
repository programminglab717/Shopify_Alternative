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
    actor: { kind: 'staff', userId: newId(), sessionId: newId(), role: 'confirmation_agent' },
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
});
