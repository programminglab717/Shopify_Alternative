import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chargeParcelsIn } from './cod-cash.js';
import { CodHealthService, type CodHealthInput } from './cod-health.service.js';
import type { AddressInput } from './address.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('CodHealthService', () => {
  let f: OrdersFixture;
  let health: CodHealthService;
  let staff: TenantContext;
  let kurta: string;
  let shawl: string;

  /** This hour's orders, by what is asked. */
  const now = (extra: Partial<CodHealthInput> = {}): CodHealthInput => ({
    placedFrom: new Date(Date.now() - 3_600_000),
    placedBefore: new Date(Date.now() + 3_600_000),
    first: 50,
    ...extra,
  });

  const at = (city: string): AddressInput => ({ ...ADDRESS, city });

  async function place(
    owner: TenantContext,
    variantIds: string[],
    city: string,
    extra: Record<string, unknown> = {},
  ) {
    return unwrap(
      await f.orders.create(owner, {
        lineItems: variantIds.map((variantId) => ({ variantId, quantity: 1 })),
        shippingAddress: at(city),
        ...extra,
      }),
    );
  }

  async function confirmed(owner: TenantContext, variantIds: string[], city: string) {
    const order = await place(owner, variantIds, city);
    return unwrap(await f.orders.confirm(f.a, order.id));
  }

  /** Charges parcels by their IDs, as a courier's statement does. */
  const charge = (charges: Record<string, bigint>) =>
    f.db.tenant(f.a.shopId, (tx) =>
      chargeParcelsIn(tx, f.a.shopId, f.a.actor, {
        charges: new Map(Object.entries(charges)),
        message: (amount, trackingNumber) => `Charged ${amount} for ${trackingNumber}`,
      }),
    );

  /** Ships the whole order: its parcel's ID. */
  async function shipped(order: { id: string }, company?: string) {
    const tracking = company ? { company, number: newId().slice(0, 10) } : null;
    return unwrap(await f.fulfillments.fulfill(f.a, order.id, { tracking })).fulfillmentId;
  }

  beforeAll(async () => {
    f = await ordersFixture(server!);
    health = new CodHealthService(f.db);
    staff = {
      ...f.a,
      actor: {
        kind: 'staff',
        userId: newId(),
        sessionId: newId(),
        authenticatedAt: new Date(),
        role: 'owner',
      },
    };
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    [shawl] = (await f.variantsOf(f.a, 'Pashmina Shawl', { price: '5,000' })) as [string];
    await f.stock(f.a, kurta, 50);
    await f.stock(f.a, shawl, 50);
  });

  /**
   * Ten cash-on-delivery orders, by an app unless staff placed them:
   * * Lahore, a kurta each, all confirmed: delivered by TCS, charged Rs 150; refused by "tcs",
   *   charged Rs 150 out and Rs 150 back; in transit with TCS; and delivered by Leopards.
   * * Karachi, a shawl each: cancelled before confirmation, waiting, and confirmed then cancelled.
   * * Chak 45 SB, typed two ways: staff's kurta and shawl, confirmed and delivered with no courier
   *   named; a kurta waiting; and staff's shawl waiting.
   * And a prepaid kurta to Lahore, delivered, which COD health leaves out.
   */
  async function aPeriodOfOrders() {
    const first = await confirmed(f.a, [kurta], 'lhr');
    const delivered = await shipped(first, 'TCS');
    unwrap(await f.fulfillments.markDelivered(f.a, delivered));
    const refused = await shipped(await confirmed(f.a, [kurta], 'Lahore'), 'tcs');
    await charge({ [delivered]: 150_00n, [refused]: 150_00n });
    unwrap(await f.fulfillments.markReturning(f.a, refused));
    unwrap(await f.fulfillments.receiveReturn(f.a, refused));
    await charge({ [refused]: 150_00n });
    await shipped(await confirmed(f.a, [kurta], 'Lahore'), 'TCS');
    const leopards = await shipped(await confirmed(f.a, [kurta], 'lahore'), 'Leopards');
    unwrap(await f.fulfillments.markDelivered(f.a, leopards));

    const declined = await place(f.a, [shawl], 'khi');
    unwrap(await f.orders.cancel(f.a, declined.id, { reason: 'customer' }));
    await place(f.a, [shawl], 'Karachi');
    const outOfStock = await confirmed(f.a, [shawl], 'Karachi');
    unwrap(await f.orders.cancel(f.a, outOfStock.id, { reason: 'inventory' }));

    const chak = await confirmed(staff, [kurta, shawl], 'Chak 45 SB');
    unwrap(await f.fulfillments.markDelivered(f.a, await shipped(chak)));
    await place(f.a, [kurta], 'chak 45 sb');
    await place(staff, [shawl], 'Chak 45 SB');

    const prepaid = await place(f.a, [kurta], 'Lahore', { paymentMethod: 'prepaid' });
    unwrap(await f.fulfillments.markDelivered(f.a, await shipped(prepaid, 'TCS')));
    return { kurtaId: first.lines[0]!.productId, shawlId: declined.lines[0]!.productId };
  }

  const none = {
    confirmation: { placed: 0, confirmed: 0, cancelled: 0, awaiting: 0 },
    delivery: {
      shipped: 0,
      delivered: 0,
      returned: 0,
      lost: 0,
      inTransit: 0,
      returnCharges: 0n,
      returnsCharged: 0,
    },
    rows: [],
  };

  /** A delivery tally with no returns charged. */
  const uncharged = { returnCharges: 0n, returnsCharged: 0 };
  /** One with the refused parcel's charges, both ways. */
  const charged = { returnCharges: 300_00n, returnsCharged: 1 };

  it("says how a period's cash-on-delivery orders went, for the shop", async () => {
    expect(unwrap(await health.report(f.a, now()))).toEqual(none);
    await aPeriodOfOrders();

    expect(unwrap(await health.report(f.a, now()))).toEqual({
      // Confirmed then cancelled is still confirmed; the prepaid order is left out.
      confirmation: { placed: 10, confirmed: 6, cancelled: 1, awaiting: 3 },
      delivery: { shipped: 5, delivered: 3, returned: 1, lost: 0, inTransit: 1, ...charged },
      rows: [],
    });
    expect(unwrap(await health.report(f.b, now()))).toEqual(none);
    const before = { placedFrom: new Date('2026-01-01'), placedBefore: new Date('2026-02-01') };
    expect(unwrap(await health.report(f.a, now(before)))).toEqual(none);
  });

  it('breaks it down by city, product, source and courier, most orders first', async () => {
    const { kurtaId, shawlId } = await aPeriodOfOrders();
    const rows = async (by: CodHealthInput['by'], first = 50) =>
      unwrap(await health.report(f.a, now({ by, first }))).rows;

    expect(await rows('city')).toEqual([
      {
        key: 'Lahore',
        title: 'Lahore',
        confirmation: { placed: 4, confirmed: 4, cancelled: 0, awaiting: 0 },
        delivery: { shipped: 4, delivered: 2, returned: 1, lost: 0, inTransit: 1, ...charged },
      },
      // Typed two ways, it goes by the way most orders have it.
      {
        key: 'Chak 45 SB',
        title: 'Chak 45 SB',
        confirmation: { placed: 3, confirmed: 1, cancelled: 0, awaiting: 2 },
        delivery: { shipped: 1, delivered: 1, returned: 0, lost: 0, inTransit: 0, ...uncharged },
      },
      {
        key: 'Karachi',
        title: 'Karachi',
        confirmation: { placed: 3, confirmed: 1, cancelled: 1, awaiting: 1 },
        delivery: { shipped: 0, delivered: 0, returned: 0, lost: 0, inTransit: 0, ...uncharged },
      },
    ]);
    expect((await rows('city', 1)).map((row) => row.title)).toEqual(['Lahore']);

    // The order with both counts for each.
    expect(await rows('product')).toEqual([
      {
        key: kurtaId,
        title: 'Kurta',
        confirmation: { placed: 6, confirmed: 5, cancelled: 0, awaiting: 1 },
        delivery: { shipped: 5, delivered: 3, returned: 1, lost: 0, inTransit: 1, ...charged },
      },
      {
        key: shawlId,
        title: 'Pashmina Shawl',
        confirmation: { placed: 5, confirmed: 2, cancelled: 1, awaiting: 2 },
        delivery: { shipped: 1, delivered: 1, returned: 0, lost: 0, inTransit: 0, ...uncharged },
      },
    ]);

    expect(await rows('source')).toEqual([
      {
        key: 'api',
        title: 'Apps',
        confirmation: { placed: 8, confirmed: 5, cancelled: 1, awaiting: 2 },
        delivery: { shipped: 4, delivered: 2, returned: 1, lost: 0, inTransit: 1, ...charged },
      },
      {
        key: 'manual',
        title: 'Entered by staff',
        confirmation: { placed: 2, confirmed: 1, cancelled: 0, awaiting: 1 },
        delivery: { shipped: 1, delivered: 1, returned: 0, lost: 0, inTransit: 0, ...uncharged },
      },
    ]);

    // Parcels alone, by the courier's name however it was typed.
    expect(await rows('courier')).toEqual([
      {
        key: 'TCS',
        title: 'TCS',
        confirmation: null,
        delivery: { shipped: 3, delivered: 1, returned: 1, lost: 0, inTransit: 1, ...charged },
      },
      {
        key: 'Leopards',
        title: 'Leopards',
        confirmation: null,
        delivery: { shipped: 1, delivered: 1, returned: 0, lost: 0, inTransit: 0, ...uncharged },
      },
      {
        key: null,
        title: 'No courier named',
        confirmation: null,
        delivery: { shipped: 1, delivered: 1, returned: 0, lost: 0, inTransit: 0, ...uncharged },
      },
    ]);
  });

  it('counts parcels lost on their way out apart from those refused, though one turned up', async () => {
    const lost = await shipped(await confirmed(f.a, [kurta], 'Lahore'), 'Leopards');
    unwrap(await f.fulfillments.markLost(f.a, lost));
    const found = await shipped(await confirmed(f.a, [kurta], 'Lahore'), 'Leopards');
    unwrap(await f.fulfillments.markLost(f.a, found));
    unwrap(await f.fulfillments.receiveReturn(f.a, found));
    // Refused, then lost on its way back: refused all the same.
    const refused = await shipped(await confirmed(f.a, [kurta], 'Lahore'), 'Leopards');
    unwrap(await f.fulfillments.markReturning(f.a, refused));
    unwrap(await f.fulfillments.markLost(f.a, refused));
    // What the lost parcels cost is not what a return cost.
    await charge({ [lost]: 100_00n, [found]: 100_00n, [refused]: 200_00n });
    const delivery = {
      shipped: 3,
      delivered: 0,
      returned: 1,
      lost: 2,
      inTransit: 0,
      returnCharges: 200_00n,
      returnsCharged: 1,
    };
    expect(unwrap(await health.report(f.a, now())).delivery).toEqual(delivery);
    expect(unwrap(await health.report(f.a, now({ by: 'courier' }))).rows).toEqual([
      { key: 'Leopards', title: 'Leopards', confirmation: null, delivery },
    ]);
  });

  it('adds up what returns cost, each parcel once, as statements charged them', async () => {
    const [small, medium] = await f.variantsOf(f.a, 'Lawn Suit', { sizes: ['S', 'M'] });
    await f.stock(f.a, small!, 5);
    await f.stock(f.a, medium!, 5);
    // Both sizes in one parcel, refused; another, refused and not yet charged.
    const order = await confirmed(f.a, [small!, medium!], 'Multan');
    const parcel = await shipped(order, 'PostEx');
    unwrap(await f.fulfillments.markReturning(f.a, parcel));
    const later = await shipped(await confirmed(f.a, [small!], 'Multan'), 'PostEx');
    unwrap(await f.fulfillments.markReturning(f.a, later));
    await f.admin.query('DELETE FROM platform.outbox_events');
    await charge({ [parcel]: 180_00n });
    await charge({ [parcel]: 180_00n, [later]: 0n });

    // Kept on the parcel, which its order says it changed.
    const after = (await f.orders.get(f.a, order.id))!;
    expect(after.fulfillments[0]!.courierCharges).toBe(360_00n);
    const timeline = await f.orders.timeline(f.a, order.id, { first: 50 });
    expect(timeline.items.filter((entry) => entry.kind === 'charged')).toHaveLength(2);
    expect((await f.outbox()).map((event) => [event.event_type, event.payload.changed])).toEqual([
      ['fulfillment.updated', ['courierCharges']],
      ['fulfillment.updated', ['courierCharges']],
    ]);
    expect((await f.orders.get(f.a, order.id))!.version).toBeGreaterThan(order.version);

    const delivery = {
      shipped: 2,
      delivered: 0,
      returned: 2,
      lost: 0,
      inTransit: 0,
      returnCharges: 360_00n,
      returnsCharged: 1,
    };
    const report = async (by: CodHealthInput['by']) =>
      unwrap(await health.report(f.a, now({ by }))).rows.map((row) => row.delivery);
    expect(unwrap(await health.report(f.a, now())).delivery).toEqual(delivery);
    expect(await report('city')).toEqual([delivery]);
    expect(await report('courier')).toEqual([delivery]);
    // A parcel of two sizes counts once for their product.
    expect(await report('product')).toEqual([delivery]);
  });

  it('takes a period of a year at most', async () => {
    const from = new Date('2026-01-01T00:00:00+05:00');
    const days = (n: number) => new Date(from.getTime() + n * 86_400_000);
    const report = (placedBefore: Date) =>
      health.report(f.a, { placedFrom: from, placedBefore, first: 50 });
    expect(errorsOf(await report(from))).toEqual([['placedBefore', 'INVALID']]);
    expect(errorsOf(await report(days(367)))).toEqual([['placedBefore', 'INVALID']]);
    expect(unwrap(await report(days(366)))).toEqual(none);
  });
});
