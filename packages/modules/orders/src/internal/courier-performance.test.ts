import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CourierPerformanceService } from './courier-performance.service.js';
import { estimateParcelChargesIn } from './parcel-estimates.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Couriers' performance (ADR-384)", () => {
  let f: OrdersFixture;
  let performance: CourierPerformanceService;
  let kurta: string;

  const period = {
    shippedFrom: new Date(Date.now() - 30 * 86_400_000),
    shippedBefore: new Date(Date.now() + 86_400_000),
    cities: 10,
  };

  beforeAll(async () => {
    f = await ordersFixture(server!);
    performance = new CourierPerformanceService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);
  });

  /** A parcel shipped with `company` to `city`, `days` ago. */
  async function shipped(company: string | null, city: string, days: number) {
    const order = await f.order(f.a, [kurta], { shippingAddress: { ...ADDRESS, city } });
    unwrap(await f.orders.confirm(f.a, order.id));
    const { fulfillmentId } = unwrap(
      await f.fulfillments.fulfill(f.a, order.id, {
        tracking: company === null ? null : { company, number: `T-${order.number}` },
      }),
    );
    await f.admin.query(
      `UPDATE orders.fulfillments SET shipped_at = now() - make_interval(days => $2) WHERE id = $1`,
      [fulfillmentId, days],
    );
    return fulfillmentId;
  }

  /** Delivered `days` after it shipped. */
  async function delivered(parcel: string, days: number) {
    unwrap(await f.fulfillments.markDelivered(f.a, parcel));
    await f.admin.query(
      `UPDATE orders.fulfillments SET delivered_at = shipped_at + make_interval(days => $2)
        WHERE id = $1`,
      [parcel, days],
    );
  }

  it('tells each courier, and each of its cities, delivered, returned, lost and how long', async () => {
    // PostEx: two delivered in Karachi, in 2 and 3 days; one refused in Lahore.
    await delivered(await shipped('PostEx', 'Karachi', 10), 2);
    await delivered(await shipped('postex ', 'Karachi', 9), 3);
    unwrap(await f.fulfillments.markReturning(f.a, await shipped('PostEx', 'Lahore', 8)));
    // Leopards: one delivered in a day in Lahore, one lost, one still on its way.
    await delivered(await shipped('Leopards', 'Lahore', 7), 1);
    unwrap(await f.fulfillments.markLost(f.a, await shipped('Leopards', 'Lahore', 6)));
    await shipped('Leopards', 'Multan', 1);
    // The shop's own rider, and a parcel from before the period.
    await delivered(await shipped(null, 'Karachi', 2), 0);
    await shipped('PostEx', 'Karachi', 60);

    const report = unwrap(await performance.report(f.a, period));
    expect(report.map((row) => [row.title, row.shipped])).toEqual([
      ['Leopards', 3],
      ['PostEx', 3],
      ['No courier named', 1],
    ]);
    const postex = report.find((row) => row.title === 'PostEx')!;
    expect(postex).toMatchObject({
      courier: 'PostEx',
      delivered: 2,
      returned: 1,
      lost: 0,
      inTransit: 0,
      daysToDeliver: 2.5,
    });
    expect(postex.cities).toEqual([
      expect.objectContaining({ city: 'Karachi', shipped: 2, delivered: 2, daysToDeliver: 2.5 }),
      expect.objectContaining({ city: 'Lahore', shipped: 1, returned: 1, daysToDeliver: null }),
    ]);
    const leopards = report.find((row) => row.title === 'Leopards')!;
    expect(leopards).toMatchObject({ delivered: 1, lost: 1, inTransit: 1, daysToDeliver: 1 });
    expect(leopards.cities.map((city) => [city.city, city.shipped])).toEqual([
      ['Lahore', 2],
      ['Multan', 1],
    ]);
    expect(report.find((row) => row.courier === null)!.title).toBe('No courier named');
    expect(unwrap(await performance.report(f.b, period))).toEqual([]);
    // Cities each courier lists at most.
    const one = unwrap(await performance.report(f.a, { ...period, cities: 1 }));
    expect(one.find((row) => row.title === 'Leopards')!.cities).toHaveLength(1);
  });

  it('costs parcels by their statements, else their rate cards (ADR-383)', async () => {
    const charged = await shipped('PostEx', 'Karachi', 3);
    await f.admin.query('UPDATE orders.fulfillments SET courier_charges = 30000 WHERE id = $1', [
      charged,
    ]);
    const estimated = await shipped('PostEx', 'Karachi', 2);
    await f.db.tenant(f.a.shopId, (tx) =>
      estimateParcelChargesIn(tx, f.a.shopId, estimated, {
        out: 25_000n,
        codFee: 5_000n,
        back: 12_500n,
      }),
    );
    await shipped('PostEx', 'Karachi', 1);

    const [postex] = unwrap(await performance.report(f.a, period));
    expect(postex).toMatchObject({
      shipped: 3,
      // Rs 300 charged, and Rs 250 out and Rs 50 of the cash while on its way.
      charges: 60_000n,
      parcelsCosted: 2,
      chargesEstimated: 30_000n,
    });
  });

  it('refuses a period the wrong way round or longer than a year', async () => {
    expect(
      errorsOf(
        await performance.report(f.a, {
          ...period,
          shippedBefore: period.shippedFrom,
        }),
      ),
    ).toEqual([['shippedBefore', 'INVALID']]);
    expect(
      errorsOf(
        await performance.report(f.a, {
          ...period,
          shippedFrom: new Date(period.shippedBefore.getTime() - 367 * 86_400_000),
        }),
      ),
    ).toEqual([['shippedBefore', 'INVALID']]);
  });
});
