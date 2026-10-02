import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerAnswers, messageLinkIn } from './customer-answers.js';
import { ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Customers' answers to the shop's messages", () => {
  let f: OrdersFixture;
  let answers: CustomerAnswers;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    answers = new CustomerAnswers(f.db, f.orders);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 10);
  });

  /** The order's latest timeline entry, as [kind, who, message]. */
  const latest = async (orderId: string) =>
    (await f.orders.timeline(f.a, orderId, { first: 1 })).items.map((entry) => [
      entry.kind,
      entry.actorKind,
      entry.message,
    ]);

  const stateOf = async (orderId: string) => {
    const order = (await f.orders.getMany(f.a, [orderId])).get(orderId)!;
    return [order.status, order.confirmationStatus, order.cancelReason];
  };

  const linkIn = (shopId: string, orderId: string) =>
    f.db.tenant(shopId, (tx) =>
      messageLinkIn(tx, shopId, orderId, 'with the message asking them to confirm the order'),
    );

  it("makes a link for a message, the order's as one staff made would be", async () => {
    const order = await f.order(f.a, [kurta]);
    const path = await linkIn(f.a.shopId, order.id);
    expect(path).toMatch(/^\/o\/[\w-]{22}$/);
    const token = path!.slice('/o/'.length);
    expect((await f.links.viewLink(token)).kind).toBe('order');
    expect(await latest(order.id)).toEqual([
      [
        'link',
        'system',
        'Sent the customer a link with the message asking them to confirm the order',
      ],
    ]);
    expect(
      (await f.outbox()).filter((event) => event.event_type === 'order.updated').at(-1),
    ).toMatchObject({ aggregate_id: order.id, payload: { changed: ['link'] } });
    // A link staff make after it takes its place, as links do.
    unwrap(await f.links.createLink(f.a, order.id));
    expect((await f.links.viewLink(token)).kind).toBe('not_found');
    // None for another shop's order, nor for one cancelled.
    expect(await linkIn(f.b.shopId, order.id)).toBeNull();
    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));
    expect(await linkIn(f.a.shopId, order.id)).toBeNull();
  });

  it('confirms or cancels as the customer answers, as their link would, once', async () => {
    const confirmed = await f.order(f.a, [kurta]);
    const cancelled = await f.order(f.a, [kurta]);
    expect(await answers.answer(f.a.shopId, confirmed.id, 'confirm', 'on WhatsApp')).toBe(
      'confirmed',
    );
    expect(await answers.answer(f.a.shopId, confirmed.id, 'confirm', 'on WhatsApp')).toBe(
      'unchanged',
    );
    expect(await stateOf(confirmed.id)).toEqual(['open', 'confirmed', null]);
    expect(await latest(confirmed.id)).toEqual([
      ['confirmed', 'system', 'Confirmed by the customer on WhatsApp'],
    ]);

    expect(await answers.answer(f.a.shopId, cancelled.id, 'cancel', 'on WhatsApp')).toBe(
      'cancelled',
    );
    expect(await answers.answer(f.a.shopId, cancelled.id, 'cancel', 'on WhatsApp')).toBe(
      'unchanged',
    );
    expect(await answers.answer(f.a.shopId, cancelled.id, 'confirm', 'on WhatsApp')).toBe(
      'unchanged',
    );
    expect(await stateOf(cancelled.id)).toEqual(['cancelled', 'rejected', 'customer']);
    expect(await latest(cancelled.id)).toEqual([
      ['cancelled', 'system', 'Cancelled by the customer on WhatsApp'],
    ]);
    expect(await answers.answer(f.b.shopId, confirmed.id, 'confirm', 'on WhatsApp')).toBe(
      'not_found',
    );
  });

  it('cancels after confirming until the order is packed, and tells the shop of a late answer', async () => {
    const changed = await f.order(f.a, [kurta]);
    const packed = await f.order(f.a, [kurta]);
    for (const order of [changed, packed]) unwrap(await f.orders.confirm(f.a, order.id));
    expect(await answers.answer(f.a.shopId, changed.id, 'cancel', 'on WhatsApp')).toBe('cancelled');
    expect(await latest(changed.id)).toEqual([
      ['cancelled', 'system', 'Cancelled by the customer on WhatsApp, after confirming it'],
    ]);

    unwrap(await f.orders.markPacked(f.a, packed.id));
    expect(await answers.answer(f.a.shopId, packed.id, 'cancel', 'on WhatsApp')).toBe('too_late');
    expect(await stateOf(packed.id)).toEqual(['open', 'confirmed', null]);
    expect(await latest(packed.id)).toEqual([
      [
        'customer_request',
        'system',
        'The customer asked on WhatsApp to cancel the order, too late to cancel it themselves',
      ],
    ]);

    expect(await answers.note(f.a.shopId, packed.id, 'to change the address', 'on WhatsApp')).toBe(
      true,
    );
    expect(await latest(packed.id)).toEqual([
      ['customer_request', 'system', 'The customer asked on WhatsApp to change the address'],
    ]);
    expect(await answers.note(f.b.shopId, packed.id, 'to change the address', 'on WhatsApp')).toBe(
      false,
    );
  });
});
