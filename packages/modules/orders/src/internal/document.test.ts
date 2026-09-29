import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

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
    actor: { kind: 'staff', userId: newId(), sessionId: newId(), role },
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
      'Ship to Ayesha Khan House 12, Street 4, Block 5 Near Jamia Masjid Karachi 75300, Sindh ' +
      '0300 1234567';
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

    const english = await invoice('english');
    expect(english.title).toBe(`Invoice #${order.number}`);
    expect(pagesOf(english.html)).toEqual([
      `A Invoice #${order.number} 29 Sep 2026 Bill to Ayesha Khan House 12, Street 4, Block 5 ` +
        'Near Jamia Masjid Karachi 75300, Sindh 0300 1234567 ayesha@example.com ' +
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
    expect(page).toMatch(/^Cancelled A Invoice #\d+ \d+ \w+ \d{4} Bill to Karachi, Sindh Payment /);
    expect(page).not.toContain('Ayesha');
    expect(page).not.toContain('0300');
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
