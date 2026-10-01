import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentPerformanceService } from './agent-performance.service.js';
import { ConfirmationDeskService } from './confirmation-desk.service.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('AgentPerformanceService', () => {
  let f: OrdersFixture;
  let desk: ConfirmationDeskService;
  let agents: AgentPerformanceService;
  let kurta: string;
  let phones = 0;

  /** A confirmation agent of `owner`'s shop. */
  const agent = (owner: TenantContext): TenantContext & { actor: { userId: string } } => ({
    ...owner,
    actor: { kind: 'staff', userId: newId(), sessionId: newId(), role: 'confirmation_agent' },
  });

  /** A cash-on-delivery order waiting to be confirmed, from a number of its own. */
  async function waiting(owner: TenantContext, extra: Record<string, unknown> = {}) {
    const [variantId] =
      owner === f.a ? [kurta] : await f.variantsOf(owner, 'Shawl', { price: '3,000' });
    if (owner !== f.a) await f.stock(owner, variantId!, 10);
    return unwrap(
      await f.orders.create(owner, {
        lineItems: [{ variantId: variantId!, quantity: 1 }],
        shippingAddress: { ...ADDRESS, phone: `0300 22233${String(phones++).padStart(2, '0')}` },
        ...extra,
      }),
    );
  }

  /** Moves what `actorId` did, on timelines and in calls, to `at`. */
  async function movedTo(actorId: string, at: string, what: 'events' | 'calls' | 'both') {
    if (what !== 'calls') {
      await f.admin.query('UPDATE orders.order_events SET created_at = $2 WHERE actor_id = $1', [
        actorId,
        at,
      ]);
    }
    if (what !== 'events') {
      await f.admin.query(
        'UPDATE orders.confirmation_calls SET created_at = $2 WHERE actor_id = $1',
        [actorId, at],
      );
    }
  }

  /** The last day of September, in Karachi. */
  const day = {
    from: new Date('2026-09-30T00:00:00+05:00'),
    before: new Date('2026-10-01T00:00:00+05:00'),
  };

  const none = {
    shipped: 0,
    delivered: 0,
    returned: 0,
    lost: 0,
    inTransit: 0,
    returnCharges: 0n,
    returnsCharged: 0,
  };

  beforeAll(async () => {
    f = await ordersFixture(server!);
    desk = new ConfirmationDeskService(f.db);
    agents = new AgentPerformanceService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 100);
  });

  it('says what each agent did over a period, and how the orders they confirmed turned out', async () => {
    const [ali, sana] = [agent(f.a), agent(f.a)];
    const later = new Date(Date.now() + 3_600_000);

    // Ali: three confirmed, one delivered, one refused and one not shipped; one cancelled as its
    // customer declined; two calls unanswered and one to call back.
    const delivered = await waiting(f.a);
    unwrap(await desk.recordCall(ali, delivered.id, { outcome: 'no_answer' }));
    unwrap(await f.orders.confirm(ali, delivered.id));
    const refused = await waiting(f.a);
    unwrap(await f.orders.confirm(ali, refused.id));
    const notShipped = await waiting(f.a);
    unwrap(await desk.recordCall(ali, notShipped.id, { outcome: 'call_back', callBackAt: later }));
    unwrap(await f.orders.confirm(ali, notShipped.id));
    const declined = await waiting(f.a);
    unwrap(await desk.recordCall(ali, declined.id, { outcome: 'no_answer' }));
    unwrap(await f.orders.cancel(ali, declined.id, { reason: 'customer' }));
    for (const [order, done] of [
      [delivered, 'markDelivered'],
      [refused, 'markReturning'],
    ] as const) {
      const parcel = unwrap(await f.fulfillments.fulfill(f.a, order.id, {})).fulfillmentId;
      unwrap(await f.fulfillments[done](f.a, parcel));
    }
    // Their confirmations and cancellation at 09:10, their calls at 11:05: two hours on the desk.
    await movedTo(ali.actor.userId, '2026-09-30T09:10:00+05:00', 'events');
    await movedTo(ali.actor.userId, '2026-09-30T11:05:00+05:00', 'calls');
    // And a call the day before, outside the period.
    const before = await waiting(f.a);
    unwrap(await desk.recordCall(ali, before.id, { outcome: 'no_answer' }));
    await f.admin.query(
      `UPDATE orders.confirmation_calls SET created_at = '2026-09-29T18:00:00+05:00'
        WHERE order_id = $1`,
      [before.id],
    );

    // Sana: one confirmed, then cancelled, which counts as confirmed alone; a wrong number; and
    // a prepaid order cancelled, which wasn't waiting for anyone.
    const changed = await waiting(f.a);
    unwrap(await f.orders.confirm(sana, changed.id));
    unwrap(await f.orders.cancel(sana, changed.id, { reason: 'customer' }));
    const wrong = await waiting(f.a);
    unwrap(await desk.recordCall(sana, wrong.id, { outcome: 'wrong_number' }));
    const prepaid = await waiting(f.a, { paymentMethod: 'prepaid' });
    unwrap(await f.orders.cancel(sana, prepaid.id, { reason: 'customer' }));
    await movedTo(sana.actor.userId, '2026-09-30T09:50:00+05:00', 'both');

    // An app confirming through the API is an agent too; a customer through their link isn't.
    const byApp = await waiting(f.a);
    unwrap(await f.orders.confirm(f.a, byApp.id));
    const appId = (f.a.actor as { tokenId: string }).tokenId;
    await movedTo(appId, '2026-09-30T10:00:00+05:00', 'events');
    const byLink = await waiting(f.a);
    await f.admin.query(
      `INSERT INTO orders.order_events (shop_id, id, order_id, kind, message, actor_kind, created_at)
       VALUES ($1, $2, $3, 'confirmed', 'Confirmed by the customer through their link', 'system',
               '2026-09-30T10:00:00+05:00')`,
      [f.a.shopId, newId(), byLink.id],
    );
    // Another shop's agent is that shop's.
    const elsewhere = agent(f.b);
    unwrap(await f.orders.confirm(elsewhere, (await waiting(f.b)).id));
    await movedTo(elsewhere.actor.userId, '2026-09-30T10:00:00+05:00', 'events');

    const report = unwrap(await agents.report(f.a, { ...day, first: 50 }));
    expect(report).toEqual([
      {
        agent: { kind: 'staff', id: ali.actor.userId },
        confirmed: 3,
        cancelled: 1,
        calls: { noAnswer: 2, callBack: 1, wrongNumber: 0 },
        activeHours: 2,
        delivery: { ...none, shipped: 2, delivered: 1, returned: 1 },
      },
      // As many settled as the app, and more calls.
      {
        agent: { kind: 'staff', id: sana.actor.userId },
        confirmed: 1,
        cancelled: 0,
        calls: { noAnswer: 0, callBack: 0, wrongNumber: 1 },
        activeHours: 1,
        delivery: none,
      },
      {
        agent: { kind: 'app', id: appId },
        confirmed: 1,
        cancelled: 0,
        calls: { noAnswer: 0, callBack: 0, wrongNumber: 0 },
        activeHours: 1,
        delivery: none,
      },
    ]);
    expect(unwrap(await agents.report(f.a, { ...day, first: 1 })).map((row) => row.agent)).toEqual([
      { kind: 'staff', id: ali.actor.userId },
    ]);
    expect(unwrap(await agents.report(f.b, { ...day, first: 50 })).map((row) => row.agent)).toEqual(
      [{ kind: 'staff', id: elsewhere.actor.userId }],
    );
    // The day before has Ali's one call alone.
    const dayBefore = {
      from: new Date('2026-09-29T00:00:00+05:00'),
      before: day.from,
      first: 50,
    };
    expect(unwrap(await agents.report(f.a, dayBefore))).toEqual([
      {
        agent: { kind: 'staff', id: ali.actor.userId },
        confirmed: 0,
        cancelled: 0,
        calls: { noAnswer: 1, callBack: 0, wrongNumber: 0 },
        activeHours: 1,
        delivery: none,
      },
    ]);
  });

  it('takes a period of a year at most', async () => {
    const days = (n: number) => new Date(day.from.getTime() + n * 86_400_000);
    const report = (before: Date) => agents.report(f.a, { from: day.from, before, first: 50 });
    expect(errorsOf(await report(day.from))).toEqual([['before', 'INVALID']]);
    expect(errorsOf(await report(days(367)))).toEqual([['before', 'INVALID']]);
    expect(unwrap(await report(days(366)))).toEqual([]);
  });
});
