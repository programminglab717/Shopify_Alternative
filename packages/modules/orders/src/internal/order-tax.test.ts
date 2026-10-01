import 'reflect-metadata';
import { parseCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { TaxSettingsService } from '@hatti/tax/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DraftLinkView } from './draft-order.service.js';
import { toOrder } from './graphql/mappers.js';
import { draftLinkPage } from './link-pages.js';
import { shownOfOrder } from './shown-order.js';
import { ADDRESS, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

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

  it('gives back its share of the tax with each refund, all of it once refunded whole', async () => {
    unwrap(await tax.update(f.a, { rate: 18 }));
    // Paid ahead: a kurta whose Rs 2,360 includes Rs 360, and Rs 250 for delivery, which none.
    const order = await f.order(f.a, [kurta], { paymentMethod: 'prepaid', shippingPrice: '250' });
    expect(order).toMatchObject({ total: 2_610_00n, totalTax: 360_00n });
    // Rs 1,000 of Rs 2,610 carries Rs 137.93 of its tax, rounded.
    const first = unwrap(
      await f.refunds.refund(f.a, order.id, { amount: '1,000', method: 'cash' }),
    );
    expect(first.refund.tax).toBe(137_93n);
    // The rest of the order, the rest of its tax.
    const rest = unwrap(await f.refunds.refund(f.a, order.id, { amount: '1,610', method: 'cash' }));
    expect(rest.refund.tax).toBe(222_07n);
    expect(toOrder(rest.order, f.a)).toMatchObject({
      totalTax: { amount: '360.00' },
      currentTotalTax: { amount: '0.00' },
      refunds: [{ totalTax: { amount: '137.93' } }, { totalTax: { amount: '222.07' } }],
    });
    // An order of a shop that charged none gives none back.
    unwrap(await tax.update(f.a, { rate: null }));
    const untaxed = await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    const refund = unwrap(
      await f.refunds.refund(f.a, untaxed.id, { amount: '500', method: 'cash' }),
    );
    expect(refund.refund.tax).toBe(0n);
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

  it("taxes a line at its tax code's category's rate, a line a rate on its invoice", async () => {
    unwrap(
      await tax.update(f.a, {
        rate: 18,
        categories: [{ code: 'REDUCED', name: 'Reduced rate', rate: 10 }],
      }),
    );
    const ajrak = unwrap(
      await f.products.create(f.a, {
        title: 'Ajrak',
        status: 'active',
        variants: [{ price: '1,100', taxCode: 'reduced' }],
      }),
    ).variants[0]!.id;
    await f.stock(f.a, ajrak, 5);
    // Rs 2,360 at the shop's 18% includes Rs 360; Rs 1,100 at the category's 10%, Rs 100.
    const order = await f.order(f.a, [kurta, ajrak]);
    expect(order.lines.map((line) => [line.taxRate, line.tax])).toEqual([
      [1_800, 360_00n],
      [1_000, 100_00n],
    ]);
    expect(order).toMatchObject({ total: 3_460_00n, taxRate: 1_800, totalTax: 460_00n });
    const invoice = wordsOf(
      unwrap(
        await f.documents.render(f.a, [order.id], {
          kind: 'invoice',
          paper: 'a4',
          language: 'english',
        }),
      ).html,
    );
    expect(invoice).toContain(
      'Total Rs 3,460 Sales tax 10% (included) Rs 100 Sales tax 18% (included) Rs 360',
    );
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

  it("works out a draft's tax as the order it becomes keeps it, and shows it on its link", async () => {
    unwrap(
      await tax.update(f.a, {
        rate: 18,
        taxDelivery: true,
        categories: [{ code: 'REDUCED', name: 'Reduced rate', rate: 10 }],
      }),
    );
    const ajrak = unwrap(
      await f.products.create(f.a, {
        title: 'Ajrak',
        status: 'active',
        variants: [{ price: '1,100', taxCode: 'reduced' }],
      }),
    ).variants[0]!.id;
    await f.stock(f.a, ajrak, 5);
    const lineItems = [kurta, ajrak, book].map((variantId) => ({ variantId, quantity: 1 }));
    const taxOf = async (id: string) =>
      (await f.drafts.taxesOf(f.a, [(await f.drafts.get(f.a, id))!])).get(id);

    // Rs 446 off, shared by price: the kurta is paid Rs 2,124, which includes Rs 324 at 18%; the
    // ajrak Rs 990, Rs 90 at its category's 10%; the book nothing. Delivery's Rs 236, Rs 36.
    const open = unwrap(
      await f.drafts.create(f.a, {
        lineItems,
        discount: '446',
        shippingPrice: '236',
        shippingAddress: ADDRESS,
      }),
    );
    expect(open.total).toBe(4_250_00n);
    expect(await taxOf(open.id)).toEqual({
      total: 450_00n,
      byRate: new Map([
        [1_000, 90_00n],
        [1_800, 360_00n],
      ]),
    });
    // Its link's page says so, under its total.
    const link = unwrap(await f.drafts.createLink(f.a, open.id));
    const token = link.url.slice('https://hatti.test/d/'.length);
    const view = (await f.drafts.viewLink(token)) as Extract<DraftLinkView, { kind: 'open' }>;
    expect(view).toMatchObject({ kind: 'open', tax: { total: 450_00n } });
    expect(wordsOf(draftLinkPage(view).html)).toContain(
      'Sales tax 10% (included) سیلز ٹیکس 10% (شامل) Rs 90 ' +
        'Sales tax 18% (included) سیلز ٹیکس 18% (شامل) Rs 360',
    );

    // A page opened before the shop's tax changed does not confirm the order: the customer sees
    // the tax it includes now first, which the order then keeps.
    unwrap(await tax.update(f.a, { taxDelivery: false }));
    expect(await f.drafts.confirmLink(token, view.shown)).toMatchObject({
      kind: 'open',
      tax: { total: 414_00n },
      problem: { kind: 'changed' },
    });
    const now = (await f.drafts.viewLink(token)) as Extract<DraftLinkView, { kind: 'open' }>;
    const confirmed = await f.drafts.confirmLink(token, now.shown);
    if (confirmed.kind !== 'completed') throw new Error(`Expected an order, got ${confirmed.kind}`);
    expect(confirmed.order).toMatchObject({ total: 4_250_00n, totalTax: 414_00n });

    // Placed, a draft's tax is its order's, whatever the shop's since; drafts' are worked out
    // together.
    unwrap(await tax.update(f.a, { rate: null }));
    const untaxed = unwrap(await f.drafts.create(f.a, { lineItems }));
    const both = await f.drafts.taxesOf(
      f.a,
      await Promise.all([open.id, untaxed.id].map(async (id) => (await f.drafts.get(f.a, id))!)),
    );
    expect(both).toEqual(
      new Map([
        [
          open.id,
          {
            total: 414_00n,
            byRate: new Map([
              [1_000, 90_00n],
              [1_800, 324_00n],
            ]),
          },
        ],
        [untaxed.id, { total: 0n, byRate: new Map() }],
      ]),
    );
  });
});
