import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { TaxSettingsService } from '@hatti/tax/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SalesReportService,
  averageOrderValue,
  netSales,
  totalSales,
  type SalesReportInput,
} from './sales-report.service.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('SalesReportService', () => {
  let f: OrdersFixture;
  let sales: SalesReportService;
  let kurta: string;
  let shawl: string;

  // Monday 28 September to Wednesday 30 September 2026, in Karachi.
  const days = (extra: Partial<SalesReportInput> = {}): SalesReportInput => ({
    placedFrom: new Date('2026-09-28T00:00:00+05:00'),
    placedBefore: new Date('2026-10-01T00:00:00+05:00'),
    interval: 'day',
    topProducts: 10,
    ...extra,
  });

  /** Places an order, then dates it as if placed at `at`. */
  async function placedAt(at: string, lineItems: string[], extra: Record<string, unknown> = {}) {
    const order = await f.order(f.a, lineItems, extra);
    await f.admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [order.id, at]);
    return order;
  }

  beforeAll(async () => {
    f = await ordersFixture(server!);
    sales = new SalesReportService(f.db);
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
   * In Karachi: two kurtas at 01:30 on the 29th (still the 28th in UTC), Rs 500 off and Rs 250
   * for delivery, and a shawl later that day; a kurta and a shawl, cancelled; a kurta on the
   * 30th, refused at the door; and a kurta just after the period.
   */
  async function aFewDaysOfOrders() {
    await placedAt('2026-09-28T20:30:00Z', [kurta, kurta], {
      discount: '500',
      shippingPrice: '250',
    });
    await placedAt('2026-09-29T10:00:00Z', [shawl]);
    const cancelled = await placedAt('2026-09-29T11:00:00Z', [kurta, shawl]);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    const refused = await placedAt('2026-09-30T10:00:00Z', [kurta]);
    unwrap(await f.orders.confirm(f.a, refused.id));
    const parcel = unwrap(await f.fulfillments.fulfill(f.a, refused.id, {})).fulfillmentId;
    unwrap(await f.fulfillments.markReturning(f.a, parcel));
    await placedAt('2026-09-30T19:30:00Z', [kurta]);
  }

  const zero = {
    orders: 0,
    grossSales: 0n,
    discounts: 0n,
    returns: 0n,
    shipping: 0n,
    additionalFees: 0n,
    taxes: 0n,
  };

  it('leaves out the sales tax its amounts include, and adds it up apart, as Shopify does', async () => {
    const tax = new TaxSettingsService(f.db);
    unwrap(await tax.update(f.a, { rate: 18 }));
    // Two kurtas, Rs 500 off: the Rs 1,750 paid for each includes Rs 266.95 at 18%. Delivery
    // includes none.
    await placedAt('2026-09-28T20:30:00Z', [kurta, kurta], {
      discount: '500',
      shippingPrice: '250',
    });
    // A kurta refused at the door: its tax goes back with it.
    const refused = await placedAt('2026-09-30T10:00:00Z', [kurta]);
    expect(refused.totalTax).toBe(305_08n);
    unwrap(await f.orders.confirm(f.a, refused.id));
    const parcel = unwrap(await f.fulfillments.fulfill(f.a, refused.id, {})).fulfillmentId;
    unwrap(await f.fulfillments.markReturning(f.a, parcel));
    // A shawl through checkout, once the shop's delivery charges include the tax too, with a fee
    // for paying on delivery: of the Rs 53.39 its Rs 350 of charges include, the delivery
    // charge's share is Rs 38.14, and the fee's the rest.
    unwrap(await tax.update(f.a, { taxDelivery: true }));
    const withFee = unwrap(
      await f.db.tenant(f.a.shopId, (tx) =>
        f.orders.placeIn(
          tx,
          {
            shopId: f.a.shopId,
            currency: 'PKR',
            actor: 'system',
            source: 'online_store',
            how: 'from the online store',
          },
          {
            field: [],
            lines: [{ variantId: shawl, quantity: 1, price: null }],
            address: {
              name: 'Ayesha Khan',
              phone: '+923001234567',
              address1: 'House 12, Street 4',
              address2: null,
              landmark: null,
              city: 'Karachi',
              provinceCode: 'SD',
              zip: null,
            },
            email: null,
            paymentMethod: 'cash_on_delivery',
            shipping: 250_00n,
            discount: 0n,
            advance: 0n,
            codFee: 100_00n,
            locationId: null,
            note: '',
            tags: [],
          },
        ),
      ),
    );
    expect([withFee.totalTax, withFee.shippingTax]).toEqual([816_10n, 53_39n]);
    await f.admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [
      withFee.id,
      '2026-09-28T10:00:00Z',
    ]);

    const report = unwrap(await sales.report(f.a, days()));
    expect(report.periods.map(({ start: _, ...tally }) => tally)).toEqual([
      // Rs 5,000 includes Rs 762.71; Rs 250 for delivery, Rs 38.14; the fee of Rs 100, Rs 15.25.
      {
        orders: 1,
        grossSales: 4_237_29n,
        discounts: 0n,
        returns: 0n,
        shipping: 211_86n,
        additionalFees: 84_75n,
        taxes: 816_10n,
      },
      // Rs 2,000 includes Rs 305.08, so two came to Rs 3,389.84 before the tax; Rs 3,500 was paid
      // for them, Rs 533.90 of it tax, so Rs 423.74 of the Rs 500 off was off the price.
      {
        orders: 1,
        grossSales: 3_389_84n,
        discounts: 423_74n,
        returns: 0n,
        shipping: 250_00n,
        additionalFees: 0n,
        taxes: 533_90n,
      },
      // Refused: its items returns, without the tax that went back with them.
      {
        orders: 1,
        grossSales: 1_694_92n,
        discounts: 0n,
        returns: 1_694_92n,
        shipping: 0n,
        additionalFees: 0n,
        taxes: 0n,
      },
    ]);
    // What was paid, Rs 9,100 for the three less the kurta that came back, whichever way it is
    // added up.
    expect(totalSales(report.totals)).toBe(9_100_00n);
    expect(report.totals).toMatchObject({ grossSales: 9_322_05n, taxes: 1_350_00n });
    expect(report.topProducts.map((product) => [product.title, product.grossSales])).toEqual([
      ['Kurta', 5_084_76n],
      ['Pashmina Shawl', 4_237_29n],
    ]);
  });

  it("says what a period's orders came to, day by day in the shop's time", async () => {
    await aFewDaysOfOrders();
    const report = unwrap(await sales.report(f.a, days()));
    expect(report.periods).toEqual([
      { start: new Date('2026-09-28T00:00:00+05:00'), ...zero },
      {
        start: new Date('2026-09-29T00:00:00+05:00'),
        orders: 2,
        grossSales: 9_000_00n,
        discounts: 500_00n,
        returns: 0n,
        shipping: 250_00n,
        additionalFees: 0n,
        taxes: 0n,
      },
      // Refused: still an order, its items returns.
      {
        start: new Date('2026-09-30T00:00:00+05:00'),
        orders: 1,
        grossSales: 2_000_00n,
        discounts: 0n,
        returns: 2_000_00n,
        shipping: 0n,
        additionalFees: 0n,
        taxes: 0n,
      },
    ]);
    expect(report.totals).toEqual({
      orders: 3,
      grossSales: 11_000_00n,
      discounts: 500_00n,
      returns: 2_000_00n,
      shipping: 250_00n,
      additionalFees: 0n,
      taxes: 0n,
    });
    expect(netSales(report.totals)).toBe(8_500_00n);
    expect(averageOrderValue(report.totals)).toBe(3_500_00n);
    expect(averageOrderValue(zero)).toBeNull();

    expect(report.topProducts).toEqual([
      {
        productId: expect.any(String),
        title: 'Kurta',
        unitsSold: 3,
        orders: 2,
        grossSales: 6_000_00n,
      },
      {
        productId: expect.any(String),
        title: 'Pashmina Shawl',
        unitsSold: 1,
        orders: 1,
        grossSales: 5_000_00n,
      },
    ]);
    const top = unwrap(await sales.report(f.a, days({ topProducts: 1 }))).topProducts;
    expect(top.map((product) => product.title)).toEqual(['Kurta']);

    const other = unwrap(await sales.report(f.b, days()));
    expect(other.totals).toEqual(zero);
    expect(other.periods).toHaveLength(3);
  });

  it('counts what the courier lost as returns, as what was refused: neither was sold', async () => {
    const lost = await placedAt('2026-09-30T10:00:00Z', [shawl]);
    unwrap(await f.orders.confirm(f.a, lost.id));
    const parcel = unwrap(await f.fulfillments.fulfill(f.a, lost.id, {})).fulfillmentId;
    unwrap(await f.fulfillments.markLost(f.a, parcel));
    expect(unwrap(await sales.report(f.a, days())).totals).toEqual({
      orders: 1,
      grossSales: 5_000_00n,
      discounts: 0n,
      returns: 5_000_00n,
      shipping: 0n,
      additionalFees: 0n,
      taxes: 0n,
    });
  });

  it('divides the period into weeks from Monday, or months', async () => {
    await aFewDaysOfOrders();
    const weeks = unwrap(await sales.report(f.a, days({ interval: 'week' }))).periods;
    expect(weeks).toEqual([
      expect.objectContaining({ start: new Date('2026-09-28T00:00:00+05:00'), orders: 3 }),
    ]);
    const months = unwrap(
      await sales.report(
        f.a,
        days({ interval: 'month', placedBefore: new Date('2026-10-02T00:00:00+05:00') }),
      ),
    ).periods;
    expect(months).toEqual([
      expect.objectContaining({ start: new Date('2026-09-01T00:00:00+05:00'), orders: 3 }),
      // The kurta placed on the 1st.
      expect.objectContaining({ start: new Date('2026-10-01T00:00:00+05:00'), orders: 1 }),
    ]);
  });

  it("breaks sales down by channel, by where orders' last visits came from, and by campaign", async () => {
    /** An order of the online store's, its customer's last visit from `source` (ADR-139). */
    const cameFrom = async (id: string, source: string, campaign: string | null) => {
      const utm = campaign && { source, medium: null, campaign, term: null, content: null };
      const visit = { at: '2026-09-28T10:00:00.000Z', source, utm };
      await f.admin.query(
        `UPDATE orders.orders SET source = 'online_store', attribution = $2 WHERE id = $1`,
        [id, JSON.stringify({ first: visit, last: visit })],
      );
    };
    // From Instagram's ad, two kurtas and a kurta refused at the door; from Facebook's, a
    // shawl, the campaign spelt another way; one straight to the shop; and an app's shawl. An
    // order cancelled counts for nothing.
    const two = await placedAt('2026-09-29T05:00:00Z', [kurta, kurta]);
    await cameFrom(two.id, 'instagram', 'Eid-Sale');
    const refused = await placedAt('2026-09-29T06:00:00Z', [kurta]);
    await cameFrom(refused.id, 'instagram', 'Eid-Sale');
    unwrap(await f.orders.confirm(f.a, refused.id));
    const parcel = unwrap(await f.fulfillments.fulfill(f.a, refused.id, {})).fulfillmentId;
    unwrap(await f.fulfillments.markReturning(f.a, parcel));
    const facebook = await placedAt('2026-09-29T07:00:00Z', [shawl]);
    await cameFrom(facebook.id, 'facebook', 'eid-sale');
    const direct = await placedAt('2026-09-29T08:00:00Z', [kurta]);
    await cameFrom(direct.id, 'direct', null);
    await placedAt('2026-09-29T09:00:00Z', [shawl]);
    const cancelled = await placedAt('2026-09-29T10:00:00Z', [shawl]);
    await cameFrom(cancelled.id, 'facebook', 'eid-sale');
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));

    const rows = async (by: SalesReportInput['by'], first?: number) =>
      unwrap(await sales.report(f.a, days({ by, first }))).rows.map((row) => [
        row.key,
        row.title,
        row.orders,
        totalSales(row),
      ]);
    // Most total sales first: Instagram's kurta that came back is taken off its sales.
    expect(await rows('visit_source')).toEqual([
      ['facebook', 'Facebook', 1, 5_000_00n],
      [null, 'No visit known', 1, 5_000_00n],
      ['instagram', 'Instagram', 2, 4_000_00n],
      ['direct', 'Direct', 1, 2_000_00n],
    ]);
    expect(await rows('visit_source', 2)).toHaveLength(2);
    expect(await rows('campaign')).toEqual([
      ['Eid-Sale', 'Eid-Sale', 3, 9_000_00n],
      [null, 'No campaign', 2, 7_000_00n],
    ]);
    expect(await rows('source')).toEqual([
      ['online_store', 'Online store', 4, 11_000_00n],
      ['api', 'Apps', 1, 5_000_00n],
    ]);
    // The rows add up to the totals; without `by`, there are none.
    const report = unwrap(await sales.report(f.a, days({ by: 'visit_source' })));
    expect(totalSales(report.totals)).toBe(16_000_00n);
    expect(unwrap(await sales.report(f.a, days())).rows).toEqual([]);
  });

  it('takes a period of a year at most', async () => {
    const from = new Date('2026-01-01T00:00:00+05:00');
    const after = (n: number) => new Date(from.getTime() + n * 86_400_000);
    const report = (placedBefore: Date) =>
      sales.report(f.a, { placedFrom: from, placedBefore, interval: 'month', topProducts: 10 });
    expect(errorsOf(await report(from))).toEqual([['placedBefore', 'INVALID']]);
    expect(errorsOf(await report(after(367)))).toEqual([['placedBefore', 'INVALID']]);
    expect(unwrap(await report(after(366))).periods).toHaveLength(13);
  });
});
