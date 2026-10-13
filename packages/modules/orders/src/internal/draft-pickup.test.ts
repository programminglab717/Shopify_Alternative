import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { draftLinkPage } from './link-pages.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Drafts the customer picks up (SHP-15, ADR-390)', () => {
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

  const tokenOf = (url: string) => url.slice('https://hatti.test/d/'.length);

  /** The primary location, with its address, as customers pick up from it. */
  const counter = async () => {
    const primary = await f.primary(f.a);
    unwrap(
      await f.locations.edit(f.a, primary.id, {
        address: { address1: 'Shop 4, Liberty Market', city: 'lhr' },
      }),
    );
    return unwrap(
      await f.locations.enableLocalPickup(f.a, primary.id, { instructions: 'Ask at the counter' }),
    );
  };

  const pickupDraft = (extra: Record<string, unknown> = {}) =>
    f.drafts.create(f.a, {
      lineItems: [{ variantId: kurta, quantity: 2 }],
      shippingAddress: ADDRESS,
      deliveryMethod: 'pickup',
      ...extra,
    });

  it('is picked up at a location that offers it, with no delivery charge', async () => {
    // Nowhere offers it yet.
    expect(errorsOf(await pickupDraft())).toEqual([['input.locationId', 'BLANK']]);
    const primary = await counter();
    // Another location, not offering it, is refused.
    const godown = unwrap(await f.locations.add(f.a, { name: 'Godown' }));
    expect(errorsOf(await pickupDraft({ locationId: godown.id }))).toEqual([
      ['input.locationId', 'INVALID'],
    ]);
    expect(errorsOf(await pickupDraft({ shippingPrice: '200' }))).toEqual([
      ['input.shippingPrice', 'INVALID'],
    ]);

    // A draft sent becomes one picked up, its charge gone first.
    const sent = unwrap(
      await f.drafts.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: ADDRESS,
        shippingPrice: '250',
      }),
    );
    expect(sent.deliveryMethod).toBe('shipping');
    expect(errorsOf(await f.drafts.update(f.a, sent.id, { deliveryMethod: 'pickup' }))).toEqual([
      ['input.shippingPrice', 'INVALID'],
    ]);
    const collected = unwrap(
      await f.drafts.update(f.a, sent.id, { deliveryMethod: 'pickup', shippingPrice: null }),
    );
    expect(collected).toMatchObject({ deliveryMethod: 'pickup', shipping: 0n, total: 2_000_00n });

    // Completed, its order is picked up where the draft is.
    const done = unwrap(await f.drafts.complete(f.a, collected.id));
    const order = (await f.orders.get(f.a, done.orderId!))!;
    expect(order).toMatchObject({ deliveryMethod: 'pickup', locationId: primary.id, shipping: 0n });
    unwrap(await f.orders.confirm(f.a, order.id));
    expect(unwrap(await f.orders.markPacked(f.a, order.id)).stage).toBe('ready_for_pickup');
  });

  it('tells the customer on its link they pay when they collect it, with no delivery charge', async () => {
    await counter();
    const draft = unwrap(await pickupDraft());
    const link = unwrap(await f.drafts.createLink(f.a, draft.id));
    const page = draftLinkPage(await f.drafts.viewLink(tokenOf(link.url)));
    expect(page.status).toBe(200);
    expect(page.html).toContain('Pay when you collect it');
    expect(page.html).toContain('Collected by');
    expect(page.html).not.toContain('Delivery charges');
    expect(page.html).not.toContain('Pay on delivery');
  });
});
