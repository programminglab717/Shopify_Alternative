import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCohortsService } from './customer-cohorts.service.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Customer cohorts (ANL-04, ADR-774)', () => {
  let f: OrdersFixture;
  let cohorts: CustomerCohortsService;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    cohorts = new CustomerCohortsService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);
  });

  /** An order from `phone`, dated the 15th of the month `monthsAgo` before this one, in Karachi. */
  async function orderedAt(phone: string, monthsAgo: number) {
    const order = await f.order(f.a, [kurta], { shippingAddress: { ...ADDRESS, phone } });
    await f.admin.query(
      `UPDATE orders.orders
          SET created_at = (date_trunc('month', now() AT TIME ZONE 'Asia/Karachi')
                            - make_interval(months => $2) + interval '14 days')
                           AT TIME ZONE 'Asia/Karachi'
        WHERE id = $1`,
      [order.id, monthsAgo],
    );
    return order;
  }

  /** "YYYY-MM" of the month `monthsAgo` before this one, in Karachi. */
  function monthOf(monthsAgo: number): string {
    const now = new Date(Date.now() + 5 * 3_600_000);
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1))
      .toISOString()
      .slice(0, 7);
  }

  it('counts customers by the month of their first order, and those who came back each month after', async () => {
    // Two customers first ordered two months ago: one came back last month and this month,
    // twice this month; the other never came back.
    await orderedAt('0300-1111111', 2);
    await orderedAt('0300-1111111', 1);
    await orderedAt('0300-1111111', 0);
    await orderedAt('0300-1111111', 0);
    await orderedAt('0300-2222222', 2);
    // One first ordered last month, and came back this month.
    await orderedAt('0300-3333333', 1);
    await orderedAt('0300-3333333', 0);
    // One first ordered this month; a cancelled order counts for nothing.
    await orderedAt('0300-4444444', 0);
    const cancelled = await orderedAt('0300-5555555', 0);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    // Another shop's customers are its own.
    await f.order(f.b, [(await f.variantsOf(f.b, 'Shawl', { price: '500' }))[0]!]);

    expect(unwrap(await cohorts.cohorts(f.a, { months: 3 }))).toEqual([
      { month: monthOf(2), customers: 2, returned: [1, 1], orderedAgain: 1 },
      { month: monthOf(1), customers: 1, returned: [1], orderedAgain: 1 },
      { month: monthOf(0), customers: 1, returned: [], orderedAgain: 0 },
    ]);
    // A month with no new customers is there, with nothing.
    const longer = unwrap(await cohorts.cohorts(f.a, { months: 4 }));
    expect(longer[0]).toEqual({
      month: monthOf(3),
      customers: 0,
      returned: [0, 0, 0],
      orderedAgain: 0,
    });
    // Those who first ordered before the months asked for are left out.
    expect(unwrap(await cohorts.cohorts(f.a, { months: 1 }))).toEqual([
      { month: monthOf(0), customers: 1, returned: [], orderedAgain: 0 },
    ]);
  });

  it('covers 1 to 24 months', async () => {
    for (const months of [0, 25, 1.5]) {
      expect(errorsOf(await cohorts.cohorts(f.a, { months }))).toEqual([['months', 'INVALID']]);
    }
  });
});
