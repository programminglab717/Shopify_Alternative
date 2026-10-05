import 'reflect-metadata';
import { InputChecker } from '@hatti/api';
import { parseCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkAddress } from './address.js';
import { orderLinkPage } from './link-pages.js';
import { SalesReportService } from './sales-report.service.js';
import type { PaymentMethodValue } from './schema.js';
import { ADDRESS, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Cash on delivery's fee", () => {
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

  /** Places an order for a variant, with Rs 250 delivery, as checkout does: with `codFee`. */
  function place(paymentMethod: PaymentMethodValue, codFee: bigint, variantId = kurta) {
    const address = checkAddress(new InputChecker(), [], ADDRESS)!;
    return f.db.tenant(f.a.shopId, (tx) =>
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
          lines: [{ variantId, quantity: 1, price: null }],
          address,
          email: null,
          paymentMethod,
          shipping: 250_00n,
          discount: 0n,
          advance: 0n,
          codFee,
          locationId: null,
          note: '',
          tags: [],
        },
      ),
    );
  }

  it('keeps the fee apart from delivery, in the total and the cash collected', async () => {
    const order = unwrap(await place('cash_on_delivery', 150_00n));
    expect(order).toMatchObject({
      subtotal: 2_000_00n,
      shipping: 250_00n,
      codFee: 150_00n,
      total: 2_400_00n,
      codAmount: 2_400_00n,
    });
    // The fee counts against the law's cap on cash at the door, as the rest of it does.
    const [lehnga] = (await f.variantsOf(f.a, 'Lehnga', { price: '199,700' })) as [string];
    await f.stock(f.a, lehnga, 1);
    const capped = await place('cash_on_delivery', 150_00n, lehnga);
    expect(capped.ok ? [] : capped.errors.map((error) => error.code)).toEqual(['COD_LIMIT']);
    // Only cash on delivery has one.
    await expect(place('bank_transfer', 150_00n)).rejects.toThrow(
      'Only an order paid on delivery has a fee for it',
    );
  });

  it('shows the fee on the invoice, the export, the sales report and the customer’s page', async () => {
    const order = unwrap(await place('cash_on_delivery', 150_00n));
    const invoice = unwrap(
      await f.documents.render(f.a, [order.id], {
        kind: 'invoice',
        paper: 'a4',
        language: 'english',
      }),
    );
    expect(invoice.html).toMatch(
      /Cash on delivery fee<\/td>\s*<td class="num"><bdi dir="ltr">Rs 150/,
    );

    const [header, row] = parseCsv(unwrap(await f.exports.export(f.a, { layout: 'orders' })).csv!);
    const cell = (name: string) => row![header!.indexOf(name)];
    expect([cell('Shipping'), cell('COD fee'), cell('Total')]).toEqual([
      '250.00',
      '150.00',
      '2400.00',
    ]);

    const report = unwrap(
      await new SalesReportService(f.db).report(f.a, {
        placedFrom: new Date(Date.now() - 86_400_000),
        placedBefore: new Date(Date.now() + 60_000),
        interval: 'day',
        topProducts: 1,
      }),
    );
    expect(report.totals).toMatchObject({ shipping: 250_00n, additionalFees: 150_00n });

    const link = unwrap(await f.links.createLink(f.a, order.id));
    const view = await f.links.viewLink(link.url.split('/o/')[1]!);
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
    expect(orderLinkPage(view).html).toMatch(
      /Cash on delivery fee<\/span>[\s\S]*?Rs 150[\s\S]*?Pay on delivery[\s\S]*?Rs 2,400/,
    );
  });
});
