import 'reflect-metadata';
import { InputChecker, type TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { formatDay, qrCode, toMarkup } from '@hatti/documents';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkAddress } from './address.js';
import { shownLineProperties } from './documents.js';
import { creditNoteName, invoiceName, taxYearOf } from './invoice-series.js';
import { orderLinkPage } from './link-pages.js';
import { mapUrlOf } from './location.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

/** A page's words as a reader sees them, in order: no markup, spaces collapsed. */
function wordsOf(markup: string): string {
  return markup
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Each page of a document, as its words. */
function pagesOf(document: string): string[] {
  return document.split('<article class="page">').slice(1).map(wordsOf);
}

describe.skipIf(!server)('Packing slips and invoices', () => {
  let f: OrdersFixture;
  let kurta: string;
  let size8: string;
  let size9: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    [size8, size9] = (await f.variantsOf(f.a, 'Peshawari Chappal', {
      sizes: ['8', '9'],
      price: '3,499',
    })) as [string, string];
    for (const variant of [kurta, size8, size9]) await f.stock(f.a, variant, 20);
  });

  /** Places the order at 01:30 on 29 September in Karachi: still the 28th in UTC. */
  const placedLate = async (orderId: string) => {
    await f.admin.query(
      `UPDATE orders.orders SET created_at = '2026-09-28T20:30:00Z' WHERE id = $1`,
      [orderId],
    );
  };

  const staff = (role: 'packer' | 'owner'): TenantContext => ({
    ...f.a,
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      authenticatedAt: new Date(),
      role,
    },
  });

  it('prints packing slips for many orders, a page each, with what to pack and collect', async () => {
    const primary = await f.primary(f.a);
    unwrap(
      await f.locations.edit(f.a, primary.id, {
        address: { address1: 'Shop 4, Zainab Market', city: 'Karachi', phone: '0321 5550000' },
      }),
    );
    const cod = await f.order(f.a, [kurta, size8], { shippingPrice: '250' });
    await placedLate(cod.id);
    unwrap(await f.orders.confirm(f.a, cod.id));
    const prepaid = await f.order(f.a, [size9], { paymentMethod: 'prepaid' });
    await placedLate(prepaid.id);
    const cancelled = await f.order(f.a, [kurta]);
    await placedLate(cancelled.id);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    const [shawl] = (await f.variantsOf(f.b, 'Shawl')) as [string];
    await f.stock(f.b, shawl, 1);
    const elsewhere = await f.order(f.b, [shawl]);

    const document = unwrap(
      await f.documents.render(
        f.a,
        [cod.id, prepaid.id, cancelled.id, cod.id, elsewhere.id, newId()],
        { kind: 'packing_slip', paper: 'a4', language: 'english' },
      ),
    );
    // Given twice, an order prints once; another shop's order, or none, not at all.
    expect(document.orders.map((order) => order.id)).toEqual([cod.id, prepaid.id, cancelled.id]);
    expect(document.title).toBe('Packing slips: 3 orders');
    expect(document.fileName).toBe(`packing-slips-${cod.number}-${cancelled.number}.html`);

    const header = (number: number) =>
      `A Shop 4, Zainab Market Karachi, Sindh 0321 5550000 Packing slip #${number} 29 Sep 2026`;
    const shipTo =
      'Ship to Ayesha Khan House 12, Street 4, Block 5 Gulshan-e-Iqbal Near Jamia Masjid ' +
      'Karachi 75300, Sindh 0300 1234567';
    expect(pagesOf(document.html)).toEqual([
      `${header(cod.number)} ${shipTo} Payment Cash on delivery Cash to collect Rs 5,749 ` +
        'Item Qty Kurta 1 Peshawari Chappal 8 · PES-8 1 Items: 2 Thank you for your order!',
      `${header(prepaid.number)} ${shipTo} Payment Paid in advance Nothing to collect ` +
        'Item Qty Peshawari Chappal 9 · PES-9 1 Items: 1 Thank you for your order!',
      `Cancelled: do not ship ${header(cancelled.number)} ${shipTo} Payment Cash on delivery ` +
        'Cash to collect Rs 2,000 Item Qty Kurta 1 Items: 1 Thank you for your order!',
    ]);

    // Staff who see numbers masked print them masked; owners see them whole.
    const request = { kind: 'packing_slip', paper: 'a4', language: 'english' } as const;
    const packer = unwrap(await f.documents.render(staff('packer'), [cod.id], request));
    expect(packer.html).toContain('0300 ••••567');
    expect(packer.html).not.toContain('1234567');
    expect(packer.orders[0]!.phone).toBe('+923001234567');
    const owner = unwrap(await f.documents.render(staff('owner'), [cod.id], request));
    expect(owner.html).toContain('0300 1234567');
    expect(owner.title).toBe(`Packing slip #${cod.number}`);
    expect(owner.fileName).toBe(`packing-slip-${cod.number}.html`);
  });

  it("prints the customer's pin as a QR code the rider scans for the way (ADR-628)", async () => {
    const order = await f.order(f.a, [kurta]);
    const slip = async (language: 'english' | 'urdu') =>
      unwrap(
        await f.documents.render(f.a, [order.id], {
          kind: 'packing_slip',
          paper: 'thermal_4x6',
          language,
        }),
      ).html;
    // Without a pin, nothing of one.
    expect(await slip('english')).not.toContain('class="pin"');

    const pin = { latitude: 24.921, longitude: 67.0925 };
    await f.admin.query(
      `UPDATE orders.orders
          SET shipping_address = jsonb_set(shipping_address, '{location}', $2::jsonb)
        WHERE id = $1`,
      [order.id, JSON.stringify(pin)],
    );
    const english = await slip('english');
    expect(english).toContain(toMarkup(qrCode(mapUrlOf(pin), 'Location pin on the map')));
    expect(mapUrlOf(pin)).toBe('https://www.google.com/maps/search/?api=1&query=24.921,67.0925');
    expect(pagesOf(english)[0]).toContain(
      '0300 1234567 Location pin Scan it for the way to the customer&#39;s door Payment',
    );
    expect(await slip('urdu')).toContain('گاہک کے دروازے تک راستے کے لیے اسکین کریں');
    // An invoice is the customer's: no pin on it.
    const invoice = unwrap(
      await f.documents.render(f.a, [order.id], {
        kind: 'invoice',
        paper: 'a4',
        language: 'english',
      }),
    );
    expect(invoice.html).not.toContain('class="pin"');
  });

  it('warns on slips of orders not to pack yet, and lists what is left to ship', async () => {
    const order = await f.order(f.a, [size8, size9]);
    const slip = async () =>
      pagesOf(
        unwrap(
          await f.documents.render(f.a, [order.id], {
            kind: 'packing_slip',
            paper: 'thermal_4x6',
            language: 'english',
          }),
        ).html,
      )[0]!;
    expect(await slip()).toMatch(/^Not confirmed: do not pack yet A /);

    unwrap(await f.orders.confirm(f.a, order.id));
    expect(await slip()).toMatch(/^A /);
    unwrap(
      await f.fulfillments.fulfill(f.a, order.id, {
        lineItems: [{ id: order.lines[0]!.id, quantity: 1 }],
      }),
    );
    const partly = await slip();
    expect(partly).toMatch(/^Partly shipped: the items left to ship A /);
    expect(partly).toContain('Item Qty Peshawari Chappal 9 · PES-9 1 Items: 1');

    // Printed again once everything has shipped, a slip lists it all.
    unwrap(await f.fulfillments.fulfill(f.a, order.id, {}));
    const shipped = await slip();
    expect(shipped).toMatch(/^Already shipped A /);
    expect(shipped).toContain(
      'Peshawari Chappal 8 · PES-8 1 Peshawari Chappal 9 · PES-9 1 Items: 2',
    );
  });

  it('prints invoices with prices, what was paid and what is left, in English or Urdu', async () => {
    const order = await f.order(f.a, [size8, size9], {
      shippingPrice: '250',
      discount: '500',
      advancePaid: '250',
      email: 'ayesha@example.com',
    });
    await placedLate(order.id);
    const invoice = async (language: 'english' | 'urdu' | 'bilingual') =>
      unwrap(await f.documents.render(f.a, [order.id], { kind: 'invoice', paper: 'a4', language }));

    // Printed, the invoice is issued, the first of this tax year's series (ADR-495).
    const first = invoiceName(taxYearOf(new Date(), 'Asia/Karachi'), 1);
    const today = formatDay(new Date(), 'Asia/Karachi');
    const english = await invoice('english');
    expect(english.title).toBe(`Invoice #${order.number}`);
    expect(pagesOf(english.html)).toEqual([
      `A Invoice #${order.number} 29 Sep 2026 Invoice no. ${first} · ${today} ` +
        'Bill to Ayesha Khan House 12, Street 4, Block 5 ' +
        'Gulshan-e-Iqbal Near Jamia Masjid Karachi 75300, Sindh 0300 1234567 ayesha@example.com ' +
        'Payment Cash on delivery Item Qty Price Amount ' +
        'Peshawari Chappal 8 · PES-8 1 Rs 3,499 Rs 3,499 ' +
        'Peshawari Chappal 9 · PES-9 1 Rs 3,499 Rs 3,499 ' +
        'Subtotal Rs 6,998 Discount -Rs 500 Delivery charges Rs 250 Total Rs 6,748 ' +
        'Paid Rs 250 Balance due Rs 6,498 Thank you for your order!',
    ]);

    const urdu = await invoice('urdu');
    expect(urdu.html).toMatch(/<html\s+lang="ur"\s+dir="rtl"/);
    const [page] = pagesOf(urdu.html);
    expect(page).toContain('انوائس');
    expect(page).toContain('بقایا رقم Rs 6,498');
    expect(page).not.toContain('Balance due');
    // Names and addresses stay as they were typed, isolated so they run left to right.
    expect(urdu.html).toContain('<bdi>Ayesha Khan</bdi>');

    const both = pagesOf((await invoice('bilingual')).html)[0]!;
    expect(both).toContain('Balance due بقایا رقم Rs 6,498');
    expect(both).toContain('Thank you for your order! آپ کے آرڈر کا شکریہ!');

    // A refund shows beside what was paid; what is due does not change.
    unwrap(await f.refunds.refund(f.a, order.id, { amount: '100', method: 'cash' }));
    expect(pagesOf((await invoice('english')).html)[0]).toContain(
      'Total Rs 6,748 Paid Rs 250 Refunded Rs 100 Balance due Rs 6,498',
    );
  });

  it("keeps an erased customer's details off, and escapes what people typed", async () => {
    const order = await f.order(f.a, [kurta], {
      shippingAddress: {
        name: 'Ayesha <script>alert(1)</script>',
        phone: '0300-1234567',
        address1: 'House 12 & "Sons"',
        city: 'khi',
      },
    });
    const invoice = async () =>
      unwrap(
        await f.documents.render(f.a, [order.id], {
          kind: 'invoice',
          paper: 'thermal_80mm',
          language: 'english',
        }),
      );
    const typed = await invoice();
    expect(typed.html).toContain('<bdi>Ayesha &lt;script&gt;alert(1)&lt;/script&gt;</bdi>');
    expect(typed.html).toContain('<bdi>House 12 &amp; &quot;Sons&quot;</bdi>');
    expect(typed.html).not.toContain('<script');
    expect(typed.html).toContain('.page { width: 72mm;');

    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));
    unwrap(await f.customerData.erase(f.a, order.customerId));
    const [page] = pagesOf((await invoice()).html);
    // Issued before it was cancelled, it keeps its number.
    expect(page).toMatch(
      /^Cancelled A Invoice #\d+ \d+ \w+ \d{4} Invoice no\. INV\/\d{4}-\d{2}\/00001 · \d+ \w+ \d{4} Bill to Karachi, Sindh Payment /,
    );
    expect(page).not.toContain('Ayesha');
    expect(page).not.toContain('0300');
  });

  it('numbers invoices in a series of their own as they are first printed, none skipped or given twice (ADR-495)', async () => {
    const one = await f.order(f.a, [kurta]);
    const two = await f.order(f.a, [kurta]);
    const cancelled = await f.order(f.a, [kurta]);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    const year = taxYearOf(new Date(), 'Asia/Karachi');
    const print = (ids: string[], kind: 'invoice' | 'packing_slip' = 'invoice') =>
      f.documents.render(f.a, ids, { kind, paper: 'a4', language: 'english' });

    // A packing slip issues nothing.
    unwrap(await print([one.id], 'packing_slip'));
    expect((await f.documents.invoicesOf(f.a, [one.id])).size).toBe(0);

    // Printed together, in the order given; a cancelled order without an invoice gets none.
    unwrap(await print([two.id, cancelled.id, one.id]));
    const issued = await f.documents.invoicesOf(f.a, [one.id, two.id, cancelled.id]);
    expect([issued.get(two.id)?.name, issued.get(one.id)?.name, issued.has(cancelled.id)]).toEqual([
      invoiceName(year, 1),
      invoiceName(year, 2),
      false,
    ]);

    // Printed again, an invoice keeps its number; printed at once in two places, an order is
    // numbered once and no number is skipped.
    const three = await f.order(f.a, [kurta]);
    const four = await f.order(f.a, [kurta]);
    await Promise.all([print([one.id, three.id]), print([four.id, three.id])]);
    const after = await f.documents.invoicesOf(f.a, [one.id, three.id, four.id]);
    expect(after.get(one.id)!.number).toBe(2);
    expect([after.get(three.id)!.number, after.get(four.id)!.number].sort((a, b) => a - b)).toEqual(
      [3, 4],
    );

    // The tax year starts on 1 July in Karachi.
    expect(taxYearOf(new Date('2026-06-30T18:59:00Z'), 'Asia/Karachi')).toBe(2025);
    expect(taxYearOf(new Date('2026-06-30T19:00:00Z'), 'Asia/Karachi')).toBe(2026);
    expect(invoiceName(2099, 12)).toBe('INV/2099-00/00012');
  });

  it('puts what is refunded once an invoice is issued on credit notes of their own, and prints them (ADR-496)', async () => {
    const year = taxYearOf(new Date(), 'Asia/Karachi');
    const invoiced = await f.order(f.a, [kurta], { advancePaid: '1000' });
    const notInvoiced = await f.order(f.a, [kurta], { advancePaid: '1000' });
    const print = (ids: string[], kind: 'invoice' | 'credit_note') =>
      f.documents.render(f.a, ids, { kind, paper: 'a4', language: 'english' });

    // Refunded before its invoice is printed, an order's refund is on the invoice instead.
    const early = unwrap(
      await f.refunds.refund(f.a, invoiced.id, { amount: '100', method: 'cash' }),
    );
    expect(early.refund.creditNote).toBeNull();
    unwrap(await print([invoiced.id], 'invoice'));

    const first = unwrap(
      await f.refunds.refund(f.a, invoiced.id, {
        amount: '200',
        method: 'cash',
        note: 'One kurta came back',
      }),
    );
    const second = unwrap(
      await f.refunds.refund(f.a, invoiced.id, { amount: '50', method: 'cash' }),
    );
    expect([first.refund.creditNote?.name, second.refund.creditNote?.name]).toEqual([
      creditNoteName(year, 1),
      creditNoteName(year, 2),
    ]);
    const other = unwrap(
      await f.refunds.refund(f.a, notInvoiced.id, { amount: '100', method: 'cash' }),
    );
    expect(other.refund.creditNote).toBeNull();

    // A page for each credit note, under the invoice it corrects.
    const document = unwrap(await print([invoiced.id, notInvoiced.id], 'credit_note'));
    expect(document.title).toBe('Credit notes: 2 orders');
    const pages = pagesOf(document.html);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain(`Credit note #${invoiced.number}`);
    expect(pages[0]).toContain(`Invoice no. ${invoiceName(year, 1)}`);
    expect(pages[0]).toContain(`Credit note no. ${creditNoteName(year, 1)}`);
    expect(pages[0]).toContain('Refunded Rs 200');
    expect(pages[0]).toContain('One kurta came back');
    expect(pages[1]).toContain('Refunded Rs 50');
    expect(errorsOf(await print([notInvoiced.id], 'credit_note'))).toEqual([['ids', 'INVALID']]);
  });

  it("keeps invoices and credit notes for FBR as they are issued, while the shop's POS is connected (ADR-555)", async () => {
    const year = taxYearOf(new Date(), 'Asia/Karachi');
    await f.admin.query(
      `INSERT INTO tax.settings (shop_id, rate, tax_delivery) VALUES ($1, 1800, true)`,
      [f.a.shopId],
    );
    const print = (ids: string[], kind: 'invoice' | 'credit_note' = 'invoice') =>
      f.documents.render(f.a, ids, { kind, paper: 'a4', language: 'english' });
    const kept = async () =>
      (
        await f.admin.query<{ usin: string; kind: string; payload: Record<string, unknown> }>(
          `SELECT usin, kind, payload FROM tax.fiscal_invoices WHERE shop_id = $1 ORDER BY usin`,
          [f.a.shopId],
        )
      ).rows;

    // Before the POS is connected, nothing is kept.
    const before = await f.order(f.a, [kurta]);
    unwrap(await print([before.id]));
    expect(await kept()).toEqual([]);

    await f.admin.query(
      `INSERT INTO tax.fbr_pos (shop_id, pos_id, access_token, token_hint, environment, pct_code)
       VALUES ($1, 123456, 'sealed', 'f818', 'production', '62044200')`,
      [f.a.shopId],
    );
    // The kurta has a PCT code of its own (ADR-557); the chappal goes under the shop's.
    await f.admin.query(
      `UPDATE inventory.items SET harmonized_system_code = '62034200' WHERE variant_id = $1`,
      [kurta],
    );
    const order = await f.order(f.a, [kurta, size8], {
      shippingPrice: '250',
      discount: '500',
      advancePaid: '1000',
    });
    unwrap(await print([order.id, before.id]));
    // Printed again, it is not kept again; the invoice issued before is not reported late.
    unwrap(await print([order.id]));
    const [invoice] = await kept();
    expect(await kept()).toHaveLength(1);
    expect(invoice!.usin).toBe(invoiceName(year, 2));
    const body = invoice!.payload as {
      TotalBillAmount: number;
      TotalTaxCharged: number;
      TotalSaleValue: number;
      Discount: number;
      PaymentMode: number;
      Items: { ItemName: string; TotalAmount: number; TaxCharged: number; Discount: number }[];
    };
    // Its items add up to the order, its tax to the order's tax, as the invoice prints them.
    const rupees = (amount: bigint) => Number(amount) / 100;
    expect(body.TotalBillAmount).toBe(rupees(order.total));
    expect(body.TotalTaxCharged).toBe(rupees(order.totalTax));
    expect(body.Discount).toBe(500);
    expect(body.PaymentMode).toBe(1);
    expect(body.Items.map((item) => item.ItemName)).toEqual([
      'Kurta',
      expect.stringContaining('Peshawari Chappal'),
      'Delivery',
    ]);
    const sum = (of: (item: (typeof body.Items)[number]) => number) =>
      Math.round(body.Items.reduce((total, item) => total + of(item), 0) * 100) / 100;
    expect(sum((item) => item.TotalAmount)).toBe(body.TotalBillAmount);
    expect(sum((item) => item.TaxCharged)).toBe(body.TotalTaxCharged);
    expect(sum((item) => item.Discount)).toBe(500);
    expect(body.Items[2]).toMatchObject({ TotalAmount: 250, TaxCharged: 38.14 });
    expect(body.Items.map((item) => (item as { PCTCode?: string }).PCTCode)).toEqual([
      '62034200',
      undefined,
      undefined,
    ]);

    // A refund on it is a credit note for FBR, naming the invoice it corrects.
    unwrap(await f.refunds.refund(f.a, order.id, { amount: '200', method: 'cash' }));
    const note = (await kept()).find((each) => each.kind === 'credit_note')!;
    expect(note.usin).toBe(creditNoteName(year, 1));
    expect(note.payload).toMatchObject({
      InvoiceType: 3,
      RefUSIN: invoiceName(year, 2),
      TotalBillAmount: 200,
      TotalTaxCharged: 30.51,
    });
  });

  it("keeps invoices for FBR's digital invoicing from where they ship, to their customers, and no credit notes (ADR-562)", async () => {
    await f.admin.query(
      `INSERT INTO tax.settings (shop_id, rate, tax_delivery, ntn, strn, province)
       VALUES ($1, 1800, true, '1234567-8', '3277876175852', 'punjab')`,
      [f.a.shopId],
    );
    await f.admin.query(
      `INSERT INTO tax.fbr_pos (shop_id, system, pos_id, access_token, token_hint, environment,
                                pct_code)
       VALUES ($1, 'digital_invoicing', NULL, 'sealed', 'f818', 'sandbox', '62044200')`,
      [f.a.shopId],
    );
    const primary = await f.primary(f.a);
    unwrap(
      await f.locations.edit(f.a, primary.id, {
        address: { address1: 'Shop 4, Zainab Market', city: 'lhr' },
      }),
    );
    const print = (ids: string[], kind: 'invoice' | 'credit_note' = 'invoice') =>
      f.documents.render(f.a, ids, { kind, paper: 'a4', language: 'english' });
    const kept = async () =>
      (
        await f.admin.query<{
          usin: string;
          system: string;
          kind: string;
          status: string;
          error: string | null;
          payload: Record<string, unknown>;
        }>(
          `SELECT usin, system, kind, status, error, payload FROM tax.fiscal_invoices
            WHERE shop_id = $1 ORDER BY usin`,
          [f.a.shopId],
        )
      ).rows;

    const order = await f.order(f.a, [kurta, size8], {
      shippingPrice: '250',
      discount: '500',
      advancePaid: '1000',
    });
    unwrap(await print([order.id]));
    const [invoice] = await kept();
    expect(invoice).toMatchObject({
      system: 'digital_invoicing',
      kind: 'invoice',
      status: 'pending',
    });
    const body = invoice!.payload as {
      items: { productDescription: string; totalValues: number; salesTaxApplicable: number }[];
    };
    // The seller as the shop directory names it.
    const {
      rows: [shop],
    } = await f.admin.query<{ name: string }>('SELECT name FROM control.shops WHERE id = $1', [
      f.a.shopId,
    ]);
    expect(body).toMatchObject({
      invoiceType: 'Sale Invoice',
      sellerNTNCNIC: '1234567',
      sellerBusinessName: shop!.name,
      sellerProvince: 'Punjab',
      sellerAddress: 'Shop 4, Zainab Market, Lahore, Punjab',
      buyerBusinessName: 'Ayesha Khan',
      buyerProvince: 'Sindh',
      buyerAddress:
        'House 12, Street 4, Block 5, Gulshan-e-Iqbal, Near Jamia Masjid, Karachi 75300, Sindh',
      buyerRegistrationType: 'Unregistered',
    });
    // Its items add up to the order, the delivery charge among them.
    const rupees = (amount: bigint) => Number(amount) / 100;
    const sum = (of: (item: (typeof body.items)[number]) => number) =>
      Math.round(body.items.reduce((total, item) => total + of(item), 0) * 100) / 100;
    expect(body.items.map((item) => item.productDescription)).toEqual([
      'Kurta',
      expect.stringContaining('Peshawari Chappal'),
      'Delivery',
    ]);
    expect(sum((item) => item.totalValues)).toBe(rupees(order.total));
    expect(sum((item) => item.salesTaxApplicable)).toBe(rupees(order.totalTax));

    // A refund's credit note goes in the sales tax return, not to digital invoicing, and its
    // printed copy waits for no number from FBR.
    unwrap(await f.refunds.refund(f.a, order.id, { amount: '200', method: 'cash' }));
    expect((await kept()).find((each) => each.kind === 'credit_note')).toMatchObject({
      system: 'digital_invoicing',
      status: 'skipped',
      error: expect.stringContaining('takes no credit notes'),
    });
    const note = unwrap(await print([order.id], 'credit_note'));
    expect(pagesOf(note.html)[0]).not.toContain('FBR');

    // One collected names where it was collected.
    unwrap(await f.locations.enableLocalPickup(f.a, primary.id, { instructions: null }));
    const collected = await f.order(f.a, [kurta], { deliveryMethod: 'pickup' });
    unwrap(await print([collected.id]));
    const last = (await kept()).filter((each) => each.kind === 'invoice').at(-1)!;
    expect(last.payload).toMatchObject({
      buyerBusinessName: 'Ayesha Khan',
      buyerProvince: 'Punjab',
      buyerAddress: `Collected at ${primary.name}, Shop 4, Zainab Market, Lahore, Punjab`,
    });
  });

  it("prints FBR's number and its QR code once FBR has numbered them, or that they wait (ADR-556)", async () => {
    const year = taxYearOf(new Date(), 'Asia/Karachi');
    const print = (ids: string[], kind: 'invoice' | 'credit_note' = 'invoice') =>
      f.documents.render(f.a, ids, { kind, paper: 'a4', language: 'english' });
    // An order invoiced before the POS was connected prints as it did.
    const before = await f.order(f.a, [kurta], { advancePaid: '1000' });
    unwrap(await print([before.id]));
    await f.admin.query(
      `INSERT INTO tax.fbr_pos (shop_id, pos_id, access_token, token_hint, environment, pct_code)
       VALUES ($1, 123456, 'sealed', 'f818', 'production', '62044200')`,
      [f.a.shopId],
    );
    const order = await f.order(f.a, [kurta], { advancePaid: '1000' });

    const waiting = pagesOf(unwrap(await print([order.id, before.id])).html);
    expect(waiting[0]).toContain(
      'FBR invoice no. Awaiting FBR: print it again once FBR has numbered it',
    );
    expect(waiting[1]).not.toContain('FBR');
    expect((await f.documents.invoicesOf(f.a, [order.id])).get(order.id)?.fiscal).toMatchObject({
      status: 'pending',
      fbrInvoiceNumber: null,
    });

    const number = '123456ZZZZ17102026140509001';
    await f.admin.query(
      `UPDATE tax.fiscal_invoices SET status = 'reported', fbr_invoice_number = $2,
              reported_at = now()
        WHERE shop_id = $1 AND usin = $3`,
      [f.a.shopId, number, invoiceName(year, 2)],
    );
    const document = unwrap(await print([order.id]));
    expect(pagesOf(document.html)[0]).toContain(
      `FBR invoice no. ${number} Scan it in FBR&#39;s Tax Asaan app to check it`,
    );
    expect(document.html).toContain(`<svg class="qr" viewBox="0 0 37 37"`);
    expect(document.html).toContain(`aria-label="FBR ${number}"`);
    expect((await f.documents.invoicesOf(f.a, [order.id])).get(order.id)?.fiscal).toMatchObject({
      status: 'reported',
      fbrInvoiceNumber: number,
    });
    // In Urdu too.
    const urdu = unwrap(
      await f.documents.render(f.a, [order.id], {
        kind: 'invoice',
        paper: 'thermal_80mm',
        language: 'urdu',
      }),
    );
    expect(urdu.html).toContain('ایف بی آر انوائس نمبر');

    // A credit note waits for FBR's number of its own.
    unwrap(await f.refunds.refund(f.a, order.id, { amount: '200', method: 'cash' }));
    const note = pagesOf(unwrap(await print([order.id], 'credit_note')).html);
    expect(note[0]).toContain(`Credit note no. ${creditNoteName(year, 1)}`);
    expect(note[0]).toContain('Awaiting FBR');
  });

  it('prints the gift message on the packing slip, escaped, and none once its customer is erased (ADR-413)', async () => {
    const order = await f.order(f.a, [kurta], { giftMessage: '  Eid Mubarak <3 Ammi  ' });
    expect(order.giftMessage).toBe('Eid Mubarak <3 Ammi');
    const slip = async (language: 'english' | 'urdu') =>
      unwrap(
        await f.documents.render(f.a, [order.id], {
          kind: 'packing_slip',
          paper: 'a4',
          language,
        }),
      ).html;
    const english = await slip('english');
    expect(english).toContain('Gift message');
    expect(english).toContain('Eid Mubarak &lt;3 Ammi');
    expect(await slip('urdu')).toContain('تحفے کا پیغام');

    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));
    unwrap(await f.customerData.erase(f.a, order.customerId));
    const erased = await slip('english');
    expect(erased).not.toContain('Gift message');
    expect(erased).not.toContain('Ammi');
  });

  /** A kurta named for the shopper, an app's own property with it, and a chappal: as checkout places them. */
  async function placeNamed() {
    const address = checkAddress(new InputChecker(), [], ADDRESS)!;
    return unwrap(
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
            lines: [
              {
                variantId: kurta,
                quantity: 1,
                price: null,
                properties: { Engraving: 'Ayesha <3', _bundle_ref: 'x1' },
              },
              { variantId: size8, quantity: 1, price: null },
            ],
            address,
            email: null,
            paymentMethod: 'cash_on_delivery',
            shipping: 0n,
            discount: 0n,
            advance: 0n,
            locationId: null,
            note: '',
            tags: [],
          },
        ),
      ),
    );
  }

  it("keeps a line's properties, and prints those not apps' on the packing slip and invoice (ADR-687)", async () => {
    const order = await placeNamed();
    const kept = (await f.orders.get(f.a, order.id))!;
    expect(kept.lines.map((line) => line.properties)).toEqual([
      { Engraving: 'Ayesha <3', _bundle_ref: 'x1' },
      {},
    ]);
    expect(shownLineProperties(kept.lines[0]!)).toEqual([['Engraving', 'Ayesha <3']]);

    for (const kind of ['packing_slip', 'invoice'] as const) {
      const { html } = unwrap(
        await f.documents.render(f.a, [order.id], { kind, paper: 'a4', language: 'english' }),
      );
      // Under its item, escaped; the name and value each isolated for right-to-left pages.
      expect(wordsOf(html)).toContain('Kurta Engraving : Ayesha &lt;3');
      expect(html).not.toContain('_bundle_ref');
    }
  });

  it("shows the customer what they wrote on each line, on their order's page (ADR-688)", async () => {
    const order = await placeNamed();
    const token = unwrap(await f.links.createLink(f.a, order.id)).url.split('/o/')[1]!;
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
    const page = orderLinkPage(view).html;
    expect(wordsOf(page)).toContain('Kurta Engraving : Ayesha &lt;3');
    expect(page).not.toContain('_bundle_ref');
  });

  it('prints up to 250 orders at a time', async () => {
    const request = { kind: 'invoice', paper: 'a4', language: 'english' } as const;
    expect(errorsOf(await f.documents.render(f.a, [], request))).toEqual([['ids', 'BLANK']]);
    const many = Array.from({ length: 251 }, () => newId());
    expect(errorsOf(await f.documents.render(f.a, many, request))).toEqual([['ids', 'TOO_MANY']]);
    const none = unwrap(await f.documents.render(f.a, [newId()], request));
    expect(none).toMatchObject({
      orders: [],
      title: 'Invoices: 0 orders',
      fileName: 'invoices.html',
    });
  });
});
