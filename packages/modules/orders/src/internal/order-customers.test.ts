import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NO_ORDERS } from './records.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Orders' customers and the blocklist", () => {
  let f: OrdersFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);
  });

  /** Ships an order in one parcel, confirming it first if it needs confirming. */
  async function ship(orderId: string): Promise<string> {
    const order = unwrap(await f.orders.confirm(f.a, orderId));
    return unwrap(await f.fulfillments.fulfill(f.a, order.id, {})).fulfillmentId;
  }

  it('gives every order the customer with its number, creating new ones', async () => {
    const first = await f.order(f.a, [kurta], { email: 'ayesha@example.com' });
    const customer = await f.customers.get(f.a, first.customerId);
    expect(customer).toMatchObject({
      phone: '+923001234567',
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      version: 1,
    });
    expect((await f.outbox()).find((event) => event.event_type === 'customer.created')).toEqual({
      event_type: 'customer.created',
      aggregate_id: first.customerId,
      payload: { source: 'order', version: 1 },
    });

    // The same number in another format, under another name: the same customer, unchanged.
    const second = await f.order(f.a, [kurta], {
      shippingAddress: { ...ADDRESS, name: 'Ayesha K.', phone: '+92 300 1234567' },
    });
    expect(second.customerId).toBe(first.customerId);
    expect(await f.customers.get(f.a, first.customerId)).toEqual(customer);

    const other = await f.order(f.a, [kurta], {
      shippingAddress: { ...ADDRESS, name: 'Bilal Ahmed', phone: '0333-5551234' },
    });
    expect(other.customerId).not.toBe(first.customerId);
    expect(await f.customers.get(f.a, other.customerId)).toMatchObject({
      phone: '+923335551234',
      name: 'Bilal Ahmed',
      email: null,
    });
  });

  it('moves an order to the customer of its new number', async () => {
    const order = await f.order(f.a, [kurta]);
    // A new address with the same number keeps the customer.
    const moved = unwrap(
      await f.orders.update(f.a, order.id, { shippingAddress: { ...ADDRESS, city: 'Lahore' } }),
    );
    expect(moved.customerId).toBe(order.customerId);

    const renumbered = unwrap(
      await f.orders.update(f.a, order.id, {
        shippingAddress: { ...ADDRESS, name: 'Ayesha Khan', phone: '0321-7654321' },
      }),
    );
    expect(renumbered.customerId).not.toBe(order.customerId);
    expect(await f.customers.get(f.a, renumbered.customerId)).toMatchObject({
      phone: '+923217654321',
    });
    // The customer the number was typed wrong for keeps no orders.
    const stats = await f.orders.customerStats(f.a, [order.customerId, renumbered.customerId]);
    expect(stats.get(order.customerId)).toBeUndefined();
    expect(stats.get(renumbered.customerId)).toMatchObject({ count: 1 });
  });

  it('holds orders from blocked numbers for review, and lets staff confirm them', async () => {
    unwrap(
      await f.blocklist.add(f.a, {
        phone: '0300 1234567',
        reason: 'refused_deliveries',
        note: 'Refused 3 parcels',
      }),
    );
    const held = await f.order(f.a, [kurta]);
    expect(held).toMatchObject({ confirmationStatus: 'needs_review', stage: 'needs_review' });
    // Held, not refused: its stock is committed like any order's.
    expect(await f.level(f.a, kurta)).toMatchObject({ committed: 1 });
    const timeline = await f.orders.timeline(f.a, held.id, { first: 10 });
    expect(timeline.items.map((entry) => [entry.kind, entry.message, entry.actorKind])).toEqual([
      [
        'held',
        'Held for review: 0300 1234567 is on the blocklist for refused deliveries ' +
          '(Refused 3 parcels)',
        'system',
      ],
      ['created', 'Order #1001 placed through the API: Rs 2,000, cash on delivery', 'app'],
    ]);
    expect(errorsOf(await f.fulfillments.fulfill(f.a, held.id, {}))).toEqual([['id', 'INVALID']]);

    const confirmed = unwrap(await f.orders.confirm(f.a, held.id));
    expect(confirmed).toMatchObject({ confirmationStatus: 'confirmed', stage: 'to_fulfill' });
    expect((await f.orders.timeline(f.a, held.id, { first: 1 })).items[0]).toMatchObject({
      kind: 'confirmed',
      message: 'Reviewed and confirmed',
    });

    // Paid in advance or not, a blocked number's orders wait for review.
    const prepaid = await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    expect(prepaid).toMatchObject({ stage: 'needs_review', financialStatus: 'paid' });

    // Once unblocked, its orders go through as usual; held ones stay held.
    unwrap(await f.blocklist.remove(f.a, '03001234567'));
    expect((await f.order(f.a, [kurta])).stage).toBe('needs_confirmation');
    expect((await f.orders.get(f.a, prepaid.id))?.stage).toBe('needs_review');
  });

  it('holds an order whose number changes to a blocked one', async () => {
    unwrap(await f.blocklist.add(f.a, { phone: '03217654321', reason: 'fake_orders' }));
    const order = await f.order(f.a, [kurta]);
    unwrap(await f.orders.confirm(f.a, order.id));

    const changed = unwrap(
      await f.orders.update(f.a, order.id, {
        shippingAddress: { ...ADDRESS, phone: '03217654321' },
      }),
    );
    expect(changed).toMatchObject({ confirmationStatus: 'needs_review', stage: 'needs_review' });
    const timeline = await f.orders.timeline(f.a, order.id, { first: 2 });
    expect(timeline.items.map((entry) => entry.message)).toEqual([
      'Held for review: 0321 7654321 is on the blocklist for fake orders',
      'Changed the shipping address, customer',
    ]);

    // Another blocked number while already held: no second hold.
    unwrap(await f.blocklist.add(f.a, { phone: '03335551234', reason: 'fraud' }));
    unwrap(
      await f.orders.update(f.a, order.id, {
        shippingAddress: { ...ADDRESS, phone: '03335551234' },
      }),
    );
    const entries = await f.orders.timeline(f.a, order.id, { first: 10 });
    expect(entries.items.filter((entry) => entry.kind === 'held')).toHaveLength(1);
  });

  it("adds up a customer's orders: how many, what they paid, how they turned out", async () => {
    // Delivered and paid.
    const completed = await f.order(f.a, [kurta], { advancePaid: '200' });
    const parcel = await ship(completed.id);
    unwrap(await f.fulfillments.markDelivered(f.a, parcel));
    unwrap(await f.orders.markAsPaid(f.a, completed.id));
    // Delivered, the cash not yet in.
    unwrap(await f.fulfillments.markDelivered(f.a, await ship((await f.order(f.a, [kurta])).id)));
    // Refused at the door, with an advance kept.
    const refused = await f.order(f.a, [kurta], { advancePaid: '250' });
    const back = await ship(refused.id);
    unwrap(await f.fulfillments.markReturning(f.a, back));
    unwrap(await f.fulfillments.receiveReturn(f.a, back));
    // Prepaid, then cancelled: what was paid does not count.
    const cancelled = await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    // Waiting to be confirmed.
    const latest = await f.order(f.a, [kurta]);

    const stats = await f.orders.customerStats(f.a, [latest.customerId]);
    expect(stats.get(latest.customerId)).toEqual({
      count: 5,
      // Rs 2,000 for the completed order and Rs 250 kept from the refused one.
      amountSpent: 225_000n,
      delivered: 2,
      returned: 1,
      cancelled: 1,
      inProgress: 1,
      lastOrderAt: latest.createdAt,
    });

    // Another shop sees nothing of them.
    expect((await f.orders.customerStats(f.b, [latest.customerId])).size).toBe(0);
    expect(NO_ORDERS).toMatchObject({ count: 0, amountSpent: 0n });
  });

  it("lists a customer's orders, and the addresses they used", async () => {
    const first = await f.order(f.a, [kurta]);
    const lahore = { ...ADDRESS, address1: 'Flat 3, Gulberg III', city: 'lhr', zip: null };
    const second = await f.order(f.a, [kurta], { shippingAddress: lahore });
    const third = await f.order(f.a, [kurta]);
    const stranger = await f.order(f.a, [kurta], {
      shippingAddress: { ...ADDRESS, phone: '03335551234' },
    });

    const page = await f.orders.list(f.a, { first: 2, customerId: first.customerId });
    expect(page.items.map((order) => order.id)).toEqual([third.id, second.id]);
    expect(page.hasNextPage).toBe(true);
    const rest = await f.orders.list(f.a, {
      first: 2,
      after: second.id,
      customerId: first.customerId,
    });
    expect(rest.items.map((order) => order.id)).toEqual([first.id]);

    const addresses = await f.orders.customerAddresses(
      f.a,
      [first.customerId, stranger.customerId],
      5,
    );
    // Karachi was used last, so it comes first; each address once.
    expect(addresses.get(first.customerId)?.map((address) => address.city)).toEqual([
      'Karachi',
      'Lahore',
    ]);
    expect(addresses.get(stranger.customerId)).toHaveLength(1);
    expect(
      (await f.orders.customerAddresses(f.a, [first.customerId], 1)).get(first.customerId),
    ).toHaveLength(1);

    // Another shop sees none of it.
    expect((await f.orders.list(f.b, { first: 10, customerId: first.customerId })).items).toEqual(
      [],
    );
    expect((await f.orders.customerAddresses(f.b, [first.customerId], 5)).size).toBe(0);
  });
});
