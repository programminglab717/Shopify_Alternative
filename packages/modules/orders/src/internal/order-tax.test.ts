import 'reflect-metadata';
import { parseCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { TaxSettingsService } from '@hatti/tax/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shownOfOrder } from './shown-order.js';
import { ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

/** A document's words as a reader sees them: no markup, spaces collapsed. */
function wordsOf(markup: string): string {
  return markup
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An export's rows as objects by column, the header aside. */
function rowsOf(csv: string): Record<string, string | undefined>[] {
  const [header, ...rows] = parseCsv(csv);
  return rows.map((row) => Object.fromEntries(header!.map((name, index) => [name, row[index]])));
}

describe.skipIf(!server)('Sales tax on orders', () => {
  let f: OrdersFixture;
  let tax: TaxSettingsService;
  let kurta: string;
  let book: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    tax = new TaxSettingsService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,360' })) as [string];
    // A book, whose price includes no sales tax.
    const quran = unwrap(
      await f.products.create(f.a, {
        title: 'Quran',
        status: 'active',
        variants: [{ price: '1,000', taxable: false }],
      }),
    );
    book = quran.variants[0]!.id;
    for (const variant of [kurta, book]) await f.stock(f.a, variant, 10);
  });

  it('keeps the tax its prices include, by line and in delivery, at the rate it was placed at', async () => {
    // A shop that charges none keeps none.
    const untaxed = await f.order(f.a, [kurta]);
    expect(untaxed).toMatchObject({ taxRate: null, totalTax: 0n, shippingTax: 0n });
    expect(untaxed.lines[0]).toMatchObject({ taxable: true, taxRate: null, tax: 0n });

    unwrap(await tax.update(f.a, { rate: 18 }));
    // Rs 336 off, shared by price: the kurta is paid Rs 2,124, which includes Rs 324 at 18%, and
    // the book none. Its total is what it was: the tax is in it. Delivery has none, by default.
    const order = await f.order(f.a, [kurta, book], { discount: '336', shippingPrice: '250' });
    expect(order).toMatchObject({
      total: 3_274_00n,
      taxRate: 1_800,
      totalTax: 324_00n,
      shippingTax: 0n,
    });
    expect(order.lines.map((line) => [line.taxable, line.taxRate, line.tax])).toEqual([
      [true, 1_800, 324_00n],
      [false, null, 0n],
    ]);

    // Where delivery charges include it too: Rs 236 includes Rs 36.
    unwrap(await tax.update(f.a, { taxDelivery: true }));
    const delivered = await f.order(f.a, [kurta], { shippingPrice: '236' });
    expect(delivered).toMatchObject({ total: 2_596_00n, totalTax: 396_00n, shippingTax: 36_00n });

    // A new rate is for orders from then on: those placed keep theirs.
    unwrap(await tax.update(f.a, { rate: 17 }));
    expect(await f.orders.get(f.a, order.id)).toMatchObject({ taxRate: 1_800, totalTax: 324_00n });
    // Each shop its own.
    const [other] = (await f.variantsOf(f.b, 'Kurta', { price: '2,360' })) as [string];
    await f.stock(f.b, other, 1);
    expect(await f.order(f.b, [other])).toMatchObject({ taxRate: null, totalTax: 0n });
  });

  it('says on its invoice, its page and its export what of its total was tax', async () => {
    unwrap(await tax.update(f.a, { rate: 18 }));
    const order = await f.order(f.a, [kurta, book], { discount: '336', shippingPrice: '250' });
    const invoice = async (language: 'english' | 'urdu') =>
      wordsOf(
        unwrap(
          await f.documents.render(f.a, [order.id], { kind: 'invoice', paper: 'a4', language }),
        ).html,
      );
    // Under its total, never added to it.
    expect(await invoice('english')).toContain(
      'Delivery charges Rs 250 Total Rs 3,274 Sales tax 18% (included) Rs 324',
    );
    expect(await invoice('urdu')).toContain('سیلز ٹیکس 18% (شامل) Rs 324');
    // Its customer's page, by rate.
    expect(shownOfOrder(order).taxes).toEqual([{ rate: 1_800, tax: 324_00n }]);
    // The export, as Shopify's has its taxes: the order's, and each line's.
    const [row] = rowsOf(unwrap(await f.exports.export(f.a, { layout: 'orders' })).csv);
    expect(row).toMatchObject({ Taxes: '324.00', Total: '3274.00' });
    const lines = rowsOf(unwrap(await f.exports.export(f.a, { layout: 'line_items' })).csv);
    expect(lines.map((line) => [line.Product, line['Line tax']])).toEqual([
      ['Kurta', '324.00'],
      ['Quran', '0.00'],
    ]);
  });
});
