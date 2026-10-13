import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Local pickup (SHP-15, ADR-389)', () => {
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
    await f.stock(f.a, kurta, 10);
  });

  /** The primary location, with its address, as customers pick up from it. */
  const counter = async (instructions: string | null = 'Ask at the counter') => {
    const primary = await f.primary(f.a);
    unwrap(
      await f.locations.edit(f.a, primary.id, {
        address: { address1: 'Shop 4, Liberty Market', city: 'lhr' },
      }),
    );
    return unwrap(await f.locations.enableLocalPickup(f.a, primary.id, { instructions }));
  };

  const pickupOrder = (extra: Record<string, unknown> = {}) =>
    f.orders.create(f.a, {
      lineItems: [{ variantId: kurta, quantity: 2 }],
      shippingAddress: ADDRESS,
      deliveryMethod: 'pickup',
      ...extra,
    });

  it('lets customers pick up at a location with an address, until the shop stops it', async () => {
    const primary = await f.primary(f.a);
    // Nowhere offers it yet.
    expect(errorsOf(await pickupOrder())).toEqual([['input.locationId', 'BLANK']]);
    // A location without its street can't offer it.
    expect(
      errorsOf(await f.locations.enableLocalPickup(f.a, primary.id, { instructions: null })),
    ).toEqual([['localPickupSettings.locationId', 'INVALID']]);
    const offering = await counter();
    expect(offering.localPickup).toEqual({ instructions: 'Ask at the counter' });
    // Its address stays while it offers pickup.
    expect(
      errorsOf(await f.locations.edit(f.a, primary.id, { address: { address1: null } })),
    ).toEqual([['input.address', 'INVALID']]);
    // Another location, not offering it, is refused by name.
    const godown = unwrap(await f.locations.add(f.a, { name: 'Godown' }));
    expect(errorsOf(await pickupOrder({ locationId: godown.id }))).toEqual([
      ['input.locationId', 'INVALID'],
    ]);
    // No delivery charge for an order collected.
    expect(errorsOf(await pickupOrder({ shippingPrice: '200' }))).toEqual([
      ['input.shippingPrice', 'INVALID'],
    ]);

    const stopped = unwrap(await f.locations.disableLocalPickup(f.a, primary.id));
    expect(stopped.localPickup).toBeNull();
    expect(errorsOf(await pickupOrder())).toEqual([['input.locationId', 'BLANK']]);
  });

  it('waits ready for pickup once packed, is never booked or shipped, and completes when picked up', async () => {
    const primary = await counter();
    const placed = unwrap(await pickupOrder());
    expect(placed).toMatchObject({
      deliveryMethod: 'pickup',
      locationId: primary.id,
      stage: 'needs_confirmation',
      shipping: 0n,
    });
    // Not picked up before the customer confirms it.
    expect(errorsOf(await f.fulfillments.pickUp(f.a, placed.id))).toEqual([['id', 'INVALID']]);
    unwrap(await f.orders.confirm(f.a, placed.id));
    const packed = unwrap(await f.orders.markPacked(f.a, placed.id));
    expect(packed.stage).toBe('ready_for_pickup');
    const [entry] = (await f.orders.timeline(f.a, placed.id, { first: 1 })).items;
    expect(entry!.message).toBe('Marked as packed, ready for the customer to pick up');
    expect((await f.orders.home(f.a)).readyForPickup).toEqual({ count: 1, total: 400000n });

    // Handed over at the counter, not sent.
    expect(
      errorsOf(
        await f.fulfillments.fulfill(f.a, placed.id, { tracking: { company: 'TCS', number: '1' } }),
      ),
    ).toEqual([['id', 'INVALID']]);

    const picked = unwrap(await f.fulfillments.pickUp(f.a, placed.id));
    expect(picked.order).toMatchObject({
      stage: 'completed',
      status: 'closed',
      financialStatus: 'paid',
      amountPaid: 400000n,
      fulfillmentStatus: 'fulfilled',
    });
    expect(picked.order.fulfillments).toMatchObject([
      { id: picked.fulfillmentId, status: 'delivered', trackingCompany: null },
    ]);
    expect(
      (await f.orders.timeline(f.a, placed.id, { first: 2 })).items.map((each) => each.message),
    ).toEqual(['Rs 4,000 received at the counter', 'Picked up by the customer: 2 items']);
    // Out of stock as handed over.
    expect(await f.level(f.a, kurta)).toMatchObject({ onHand: 8, committed: 0 });
    // Done once.
    expect(errorsOf(await f.fulfillments.pickUp(f.a, placed.id))).toEqual([['id', 'INVALID']]);
  });

  it('is picked up without the ready mark, paid ahead stays paid, and a sent order is not picked up', async () => {
    await counter(null);
    const prepaid = unwrap(await pickupOrder({ paymentMethod: 'prepaid' }));
    expect(prepaid.stage).toBe('to_pack');
    const picked = unwrap(await f.fulfillments.pickUp(f.a, prepaid.id));
    expect(picked.order).toMatchObject({ stage: 'completed', amountPaid: 400000n });
    const [entry] = (await f.orders.timeline(f.a, prepaid.id, { first: 1 })).items;
    expect(entry!.message).toBe('Picked up by the customer: 2 items');

    const sent = await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    expect(errorsOf(await f.fulfillments.pickUp(f.a, sent.id))).toEqual([['id', 'INVALID']]);
    // Nor merged with an order picked up.
    const another = unwrap(await pickupOrder({ paymentMethod: 'cash_on_delivery' }));
    expect(errorsOf(await f.edits.merge(f.a, another.id, sent.id))).toEqual([
      ['intoId', 'INVALID'],
    ]);
  });
});
