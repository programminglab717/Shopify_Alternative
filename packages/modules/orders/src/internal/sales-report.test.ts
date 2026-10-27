import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { TaxSettingsService } from '@hatti/tax/public';
import { xlsxRows } from '@hatti/xlsx/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SalesReportService,
  averageOrderValue,
  grossProfit,
  netSales,
  profit,
  returnOnAdSpend,
  totalSales,
  type SalesReportInput,
} from './sales-report.service.js';
import { estimateParcelChargesIn } from './parcel-estimates.js';
import { SalesReportExportService, periodLabel } from './sales-report-export.js';
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
    // A kurta costs the shop Rs 1,200; the shawl has no cost given.
    await f.admin.query('UPDATE catalog.variants SET cost = 120000 WHERE id = $1', [kurta]);
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

  /** No costs, no couriers' charges, nothing written off or claimed. */
  const noCosts = {
    costOfGoods: 0n,
    unitsWithoutCost: 0,
    shippingCosts: 0n,
    shippingCostsEstimated: 0n,
    writeOffs: 0n,
    claimsRecovered: 0n,
    refunds: 0n,
    adSpend: 0n,
  };

  const zero = {
    orders: 0,
    grossSales: 0n,
    discounts: 0n,
    returns: 0n,
    shipping: 0n,
    additionalFees: 0n,
    taxes: 0n,
    ...noCosts,
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
              location: null,
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
        ...noCosts,
        // The shawl has no cost.
        unitsWithoutCost: 1,
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
        ...noCosts,
        costOfGoods: 2_400_00n,
      },
      // Refused: its items returns, without the tax that went back with them, and on their way
      // back, neither sold nor written off.
      {
        orders: 1,
        grossSales: 1_694_92n,
        discounts: 0n,
        returns: 1_694_92n,
        shipping: 0n,
        additionalFees: 0n,
        taxes: 0n,
        ...noCosts,
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
        ...noCosts,
        costOfGoods: 2_400_00n,
        unitsWithoutCost: 1,
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
        ...noCosts,
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
      ...noCosts,
      costOfGoods: 2_400_00n,
      unitsWithoutCost: 1,
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
        costOfGoods: 3_600_00n,
      },
      {
        productId: expect.any(String),
        title: 'Pashmina Shawl',
        unitsSold: 1,
        orders: 1,
        grossSales: 5_000_00n,
        costOfGoods: 0n,
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
      ...noCosts,
      unitsWithoutCost: 1,
    });
  });

  it('works out what the orders made: their goods, couriers, write-offs and claims (ADR-141)', async () => {
    await f.admin.query('UPDATE catalog.variants SET cost = 300000 WHERE id = $1', [shawl]);
    const at = '2026-09-29T10:00:00Z';
    const shipped = async (orderId: string) => {
      unwrap(await f.orders.confirm(f.a, orderId));
      return unwrap(await f.fulfillments.fulfill(f.a, orderId, {})).fulfillmentId;
    };
    const charged = (parcel: string, amount: number) =>
      f.admin.query('UPDATE orders.fulfillments SET courier_charges = $2 WHERE id = $1', [
        parcel,
        amount,
      ]);
    // Two kurtas delivered, the courier charging Rs 150.
    const delivered = await placedAt(at, [kurta, kurta]);
    const first = await shipped(delivered.id);
    unwrap(await f.fulfillments.markDelivered(f.a, first));
    await charged(first, 150_00);
    // A kurta refused, back and written off, charged Rs 300 out and back.
    const refused = await placedAt(at, [kurta]);
    const back = await shipped(refused.id);
    unwrap(await f.fulfillments.markReturning(f.a, back));
    unwrap(await f.fulfillments.receiveReturn(f.a, back, []));
    await charged(back, 300_00);
    // A shawl the courier lost, which paid Rs 2,500 of the claim.
    const lost = await placedAt(at, [shawl]);
    const gone = await shipped(lost.id);
    unwrap(await f.fulfillments.markLost(f.a, gone));
    await f.admin.query(
      `UPDATE orders.fulfillments
          SET claim_status = 'paid', claim_amount = 500000, claim_paid = 250000,
              claimed_at = now(), claim_settled_at = now()
        WHERE id = $1`,
      [gone],
    );
    // A kurta delivered and sent back by its customer, written off.
    const sentBack = await placedAt(at, [kurta]);
    unwrap(await f.fulfillments.markDelivered(f.a, await shipped(sentBack.id)));
    const returned = unwrap(
      await f.returns.create(f.a, {
        orderId: sentBack.id,
        returnLineItems: [{ lineItemId: sentBack.lines[0]!.id, quantity: 1, reason: 'defective' }],
      }),
    );
    unwrap(await f.returns.receive(f.a, returned.return.id, []));
    // The kurta costs more now: what was sold keeps what it cost then.
    await f.admin.query('UPDATE catalog.variants SET cost = 150000 WHERE id = $1', [kurta]);
    await placedAt(at, [kurta]);

    const totals = unwrap(await sales.report(f.a, days())).totals;
    expect(totals).toMatchObject({
      orders: 5,
      grossSales: 15_000_00n,
      returns: 9_000_00n,
      // Kept: the two delivered at Rs 1,200, and the last at Rs 1,500.
      costOfGoods: 3_900_00n,
      unitsWithoutCost: 0,
      shippingCosts: 450_00n,
      // The kurtas refused and sent back, and the shawl lost.
      writeOffs: 5_400_00n,
      claimsRecovered: 2_500_00n,
    });
    expect(netSales(totals)).toBe(6_000_00n);
    expect(grossProfit(totals)).toBe(2_100_00n);
    expect(profit(totals)).toBe(-1_250_00n);
  });

  it('counts what rate cards say parcels are likely to cost until a statement charges them (ADR-383)', async () => {
    const at = '2026-09-29T10:00:00Z';
    const shipped = async (orderId: string) => {
      unwrap(await f.orders.confirm(f.a, orderId));
      const parcel = unwrap(await f.fulfillments.fulfill(f.a, orderId, {})).fulfillmentId;
      // Rs 250 out, Rs 40 of the cash, and Rs 125 back.
      await f.db.tenant(f.a.shopId, (tx) =>
        estimateParcelChargesIn(tx, f.a.shopId, parcel, {
          out: 250_00n,
          codFee: 40_00n,
          back: 125_00n,
        }),
      );
      return parcel;
    };
    // Delivered: out and the cash fee.
    const delivered = await shipped((await placedAt(at, [kurta])).id);
    unwrap(await f.fulfillments.markDelivered(f.a, delivered));
    // Coming back: out and back.
    unwrap(
      await f.fulfillments.markReturning(f.a, await shipped((await placedAt(at, [kurta])).id)),
    );
    // Lost: out alone.
    unwrap(await f.fulfillments.markLost(f.a, await shipped((await placedAt(at, [kurta])).id)));
    // On its way: out and the cash fee, as if delivered.
    await shipped((await placedAt(at, [kurta])).id);
    // A statement charged Rs 300: that, and not the estimate.
    const charged = await shipped((await placedAt(at, [kurta])).id);
    await f.admin.query('UPDATE orders.fulfillments SET courier_charges = 30000 WHERE id = $1', [
      charged,
    ]);

    const totals = unwrap(await sales.report(f.a, days())).totals;
    expect(totals.shippingCosts).toBe(290_00n + 375_00n + 250_00n + 290_00n + 300_00n);
    expect(totals.shippingCostsEstimated).toBe(290_00n + 375_00n + 250_00n + 290_00n);
    // The parcel says it as it stands.
    const parcels = (await f.orders.get(
      f.a,
      (
        await f.admin.query<{ order_id: string }>(
          'SELECT order_id FROM orders.fulfillments WHERE id = $1',
          [delivered],
        )
      ).rows[0]!.order_id,
    ))!.fulfillments;
    expect(parcels.map((parcel) => parcel.chargeEstimate)).toEqual([290_00n]);
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

  it('takes what the shop spent on its ads off what the orders made, day by day and by campaign (ADR-553)', async () => {
    // Two kurtas from the Eid-Sale campaign's ad, on the 29th.
    const two = await placedAt('2026-09-29T05:00:00Z', [kurta, kurta]);
    const visit = {
      at: '2026-09-29T04:00:00.000Z',
      source: 'instagram',
      utm: { source: 'instagram', medium: null, campaign: 'Eid-Sale', term: null, content: null },
    };
    await f.admin.query('UPDATE orders.orders SET attribution = $2 WHERE id = $1', [
      two.id,
      JSON.stringify({ first: visit, last: visit }),
    ]);
    const spent = (
      shopId: string,
      platform: string,
      day: string,
      campaign: string,
      amount: number,
    ) =>
      f.admin.query(
        `INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [shopId, platform, day, campaign, amount],
      );
    // On the 29th, Rs 1,000 on the campaign, spelt another way, and Rs 500 on Meta besides; on the
    // 30th, Rs 300 on a campaign no order came from; the day after the period, and before it.
    await spent(f.a.shopId, 'meta', '2026-09-29', 'eid-sale', 1_000_00);
    await spent(f.a.shopId, 'meta', '2026-09-29', '', 500_00);
    await spent(f.a.shopId, 'google', '2026-09-30', 'Brand', 300_00);
    await spent(f.a.shopId, 'tiktok', '2026-10-01', '', 9_999_00);
    await spent(f.a.shopId, 'meta', '2026-09-27', '', 7_00);
    // Another shop's is its own.
    await spent(f.b.shopId, 'meta', '2026-09-29', '', 50_000_00);

    const report = unwrap(await sales.report(f.a, days()));
    expect(report.periods.map((period) => period.adSpend)).toEqual([0n, 1_500_00n, 300_00n]);
    expect(report.totals.adSpend).toBe(1_800_00n);
    // Rs 4,000 of kurtas that cost Rs 2,400, and Rs 1,800 of ads.
    expect(profit(report.totals)).toBe(-200_00n);
    expect(returnOnAdSpend(report.totals)).toBe(2.22);
    expect(report.previous.totals.adSpend).toBe(7_00n);
    // Weeks and months add the days up.
    const weeks = unwrap(await sales.report(f.a, days({ interval: 'week' })));
    expect(weeks.periods.map((period) => period.adSpend)).toEqual([1_800_00n]);

    const rows = async (by: SalesReportInput['by']) =>
      unwrap(await sales.report(f.a, days({ by }))).rows.map((row) => [
        row.key,
        row.orders,
        row.adSpend,
      ]);
    // By campaign, each one's; a campaign spent on without orders is a row of none.
    expect(await rows('campaign')).toEqual([
      ['Eid-Sale', 1, 1_000_00n],
      ['Brand', 0, 300_00n],
    ]);
    // By channel or by where visits came from, ad spend is not split.
    expect(await rows('visit_source')).toEqual([['instagram', 1, null]]);
    expect(returnOnAdSpend({ ...report.totals, adSpend: 0n })).toBeNull();
  });

  it('says what the period as long before came to, and what was refunded beside the rest (ADR-250)', async () => {
    await aFewDaysOfOrders();
    // In the three days before: a shawl, and a kurta paid ahead with Rs 300 of it given back.
    await placedAt('2026-09-26T10:00:00Z', [shawl]);
    const paid = await placedAt('2026-09-25T10:00:00Z', [kurta], { paymentMethod: 'prepaid' });
    unwrap(await f.refunds.refund(f.a, paid.id, { amount: '300', method: 'cash' }));
    // Before those three days: not in either.
    await placedAt('2026-09-24T10:00:00Z', [shawl]);
    const report = unwrap(await sales.report(f.a, days()));
    expect(report.previous.placedFrom).toEqual(new Date('2026-09-25T00:00:00+05:00'));
    expect(report.previous.totals).toMatchObject({
      orders: 2,
      grossSales: 7_000_00n,
      returns: 0n,
      refunds: 300_00n,
    });
    // Refunds are beside net sales, which take off only what came back.
    expect(netSales(report.previous.totals)).toBe(7_000_00n);
    expect(report.totals.refunds).toBe(0n);
  });

  it("exports the report as a workbook for the shop's accountant, true profit as the plan has it (ADR-798)", async () => {
    await aFewDaysOfOrders();
    const exports = new SalesReportExportService(f.db, sales);
    const now = new Date('2026-10-26T20:00:00Z');
    const file = unwrap(await exports.export(f.a, days(), true, now));
    // The day it was exported in Karachi: the 27th already.
    expect(file.filename).toBe('sales-2026-10-27.xlsx');
    expect(file.contentType).toMatch(/spreadsheetml/);
    const [header, ...rows] = xlsxRows(file.content);
    expect(header).toEqual([
      'Day',
      'Orders',
      'Gross sales',
      'Discounts',
      'Returns',
      'Net sales',
      'Shipping',
      'Additional fees',
      'Taxes',
      'Total sales',
      'Refunds',
      'Cost of goods',
      'Gross profit',
      'Shipping costs',
      'Write-offs',
      'Claims recovered',
      'Ad spend',
      'Profit',
    ]);
    expect(rows).toEqual([
      ['2026-09-28', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ['2026-09-29', 2, 9000, 500, 0, 8500, 250, 0, 0, 8750, 0, 2400, 6100, 0, 0, 0, 0, 6350],
      ['2026-09-30', 1, 2000, 0, 2000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ['Total', 3, 11000, 500, 2000, 8500, 250, 0, 0, 8750, 0, 2400, 6100, 0, 0, 0, 0, 6350],
    ]);
    expect(xlsxRows(file.content, 2)).toEqual([
      ['Product', 'Units sold', 'Orders', 'Gross sales', 'Cost of goods'],
      ['Kurta', 3, 2, 6000, 3600],
      ['Pashmina Shawl', 1, 1, 5000, 0],
    ]);
    const [channelHeader, ...channels] = xlsxRows(file.content, 3);
    expect(channelHeader![0]).toBe('Channel');
    // The fixture's orders come through an app.
    expect(channels.map((row) => row.slice(0, 3))).toEqual([['Apps', 3, 11000]]);

    // Without true profit, its lines are left out; by month, each its month.
    const monthly = unwrap(
      await exports.export(f.a, days({ interval: 'month' }), false, now),
    ).content;
    const [plain, september, total] = xlsxRows(monthly);
    expect(plain).toHaveLength(13);
    expect(plain![0]).toBe('Month');
    expect(september!.slice(0, 3)).toEqual(['2026-09', 3, 11000]);
    expect(total!.slice(0, 2)).toEqual(['Total', 3]);
    expect(periodLabel(new Date('2026-09-28T00:00:00+05:00'), 'week', 'Asia/Karachi')).toBe(
      '2026-09-28',
    );

    const audit = await f.db.tenant(f.a.shopId, (tx) => listAudit(tx, f.a.shopId, { first: 50 }));
    const exported = audit.items.filter((item) => item.action === 'sales_report.exported');
    expect(exported.map((item) => [item.action, item.details])).toEqual([
      [
        'sales_report.exported',
        {
          placedFrom: '2026-09-27T19:00:00.000Z',
          placedBefore: '2026-09-30T19:00:00.000Z',
          interval: 'MONTH',
        },
      ],
      ['sales_report.exported', expect.objectContaining({ interval: 'DAY' })],
    ]);
    // A period too long is refused as the report refuses it.
    const long = { placedBefore: new Date('2027-12-01T00:00:00+05:00') };
    expect(errorsOf(await exports.export(f.a, days(long), true))).toEqual([
      ['placedBefore', 'INVALID'],
    ]);
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
