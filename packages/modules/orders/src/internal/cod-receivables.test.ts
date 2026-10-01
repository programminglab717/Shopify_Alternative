import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CodReceivablesService } from './cod-receivables.service.js';
import { ADDRESS, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();
const DAY = 86_400_000;

describe.skipIf(!server)('CodReceivablesService', () => {
  let f: OrdersFixture;
  let receivables: CodReceivablesService;
  let kurta: string;
  let shawl: string;

  /** A confirmed order of one of `variantId`, shipped: its ID and its parcel's. */
  async function shipped(variantId: string, company: string | null, extra = {}) {
    const placed = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId, quantity: 1 }],
        shippingAddress: ADDRESS,
        ...extra,
      }),
    );
    const order =
      placed.paymentMethod === 'prepaid' ? placed : unwrap(await f.orders.confirm(f.a, placed.id));
    const tracking = company === null ? null : { company, number: newId().slice(0, 10) };
    const { fulfillmentId } = unwrap(await f.fulfillments.fulfill(f.a, order.id, { tracking }));
    return { orderId: order.id, fulfillmentId };
  }

  /** Shipped, and delivered `days` ago. */
  async function delivered(
    variantId: string,
    company: string | null,
    days: number,
    extra: Record<string, unknown> = {},
  ) {
    const parcel = await shipped(variantId, company, extra);
    unwrap(await f.fulfillments.markDelivered(f.a, parcel.fulfillmentId));
    await f.admin.query(
      `UPDATE orders.fulfillments SET delivered_at = now() - make_interval(days => $2)
        WHERE id = $1`,
      [parcel.fulfillmentId, days],
    );
    return parcel;
  }

  const none = { count: 0, amount: 0n };
  /** Every age, with what is owed at each given; null, or none given, for nothing. */
  const ages = (...cash: ([number, bigint] | null)[]) =>
    [
      { fromDays: 0, toDays: 7 },
      { fromDays: 8, toDays: 14 },
      { fromDays: 15, toDays: 30 },
      { fromDays: 31, toDays: null },
    ].map((age, index) => ({
      ...age,
      count: cash[index]?.[0] ?? 0,
      amount: cash[index]?.[1] ?? 0n,
    }));

  beforeAll(async () => {
    f = await ordersFixture(server!);
    receivables = new CodReceivablesService(f.db);
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

  it('says what couriers owe on delivered orders not yet paid, by courier and age', async () => {
    expect(await receivables.report(f.a)).toEqual({
      owed: none,
      ages: ages(),
      onTheWay: none,
      couriers: [],
    });

    await delivered(kurta, 'TCS', 3);
    await delivered(kurta, 'TCS', 1);
    const tenDays = await delivered(shawl, 'tcs', 10);
    await delivered(kurta, 'Leopards', 40);
    await delivered(kurta, null, 20);
    // Paid, prepaid, on its way, or cancelled: none of them owed.
    const paid = await delivered(kurta, 'TCS', 2);
    unwrap(await f.orders.markAsPaid(f.a, paid.orderId));
    await delivered(kurta, 'TCS', 2, { paymentMethod: 'prepaid' });
    await shipped(shawl, 'TCS');
    const cancelled = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: ADDRESS,
      }),
    );
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));

    const report = await receivables.report(f.a);
    expect(report.owed).toEqual({ count: 5, amount: 13_000_00n });
    expect(report.ages).toEqual(
      ages([2, 4_000_00n], [1, 5_000_00n], [1, 2_000_00n], [1, 2_000_00n]),
    );
    expect(report.onTheWay).toEqual({ count: 1, amount: 5_000_00n });
    // The courier as staff named it most often; then couriers named, before none.
    expect(report.couriers.map(({ oldestDeliveredAt: _, ...courier }) => courier)).toEqual([
      {
        courier: 'TCS',
        owed: { count: 3, amount: 9_000_00n },
        ages: ages([2, 4_000_00n], [1, 5_000_00n]),
      },
      {
        courier: 'Leopards',
        owed: { count: 1, amount: 2_000_00n },
        ages: ages(null, null, null, [1, 2_000_00n]),
      },
      {
        courier: null,
        owed: { count: 1, amount: 2_000_00n },
        ages: ages(null, null, [1, 2_000_00n]),
      },
    ]);
    const { rows } = await f.admin.query<{ delivered_at: Date }>(
      'SELECT delivered_at FROM orders.fulfillments WHERE id = $1',
      [tenDays.fulfillmentId],
    );
    expect(report.couriers[0]!.oldestDeliveredAt).toEqual(rows[0]!.delivered_at);

    // With the home's cash still to come, it is the same cash.
    const home = await f.orders.home(f.a);
    expect(home.cashToCollect).toEqual({
      count: report.owed.count + report.onTheWay.count,
      total: report.owed.amount + report.onTheWay.amount,
    });

    // Five days on, last week's cash has waited longer.
    const later = await receivables.report(f.a, new Date(Date.now() + 5 * DAY));
    expect(later.couriers[0]!.ages).toEqual(ages([1, 2_000_00n], [1, 2_000_00n], [1, 5_000_00n]));
    // Each shop its own.
    expect((await receivables.report(f.b)).owed).toEqual(none);
  });
});
