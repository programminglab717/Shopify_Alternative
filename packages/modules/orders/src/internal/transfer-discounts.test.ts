import 'reflect-metadata';
import { InputChecker } from '@hatti/api';
import { parseCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkAddress } from './address.js';
import { orderLinkPage } from './link-pages.js';
import type { PaymentMethodValue } from './schema.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';
import {
  transferDiscountOf,
  type TransferDiscountInput,
  type TransferDiscountValue,
} from './transfer-discount.js';

const server = testDatabaseServer();

describe('transferDiscountOf', () => {
  it('takes a percentage of the items to the rupee, up to its cap; or an amount, up to them', () => {
    const off = (discount: TransferDiscountValue | null, items: bigint) =>
      transferDiscountOf(discount, items, 'PKR');
    const fivePercent = { kind: 'percentage', percentageBps: 500, cap: null } as const;
    expect(off(null, 4_000_00n)).toBe(0n);
    expect(off(fivePercent, 4_000_00n)).toBe(200_00n);
    // 5% of Rs 4,990 is Rs 249.50, and of Rs 4,989, Rs 249.45: what is transferred stays whole.
    expect(off(fivePercent, 4_990_00n)).toBe(250_00n);
    expect(off(fivePercent, 4_989_00n)).toBe(249_00n);
    expect(off(fivePercent, 9_00n)).toBe(0n);
    expect(off({ ...fivePercent, cap: 150_00n }, 4_000_00n)).toBe(150_00n);
    expect(off({ ...fivePercent, cap: 150_00n }, 2_000_00n)).toBe(100_00n);
    // Half of a rupee rounds up to all of it, and no more.
    expect(off({ kind: 'percentage', percentageBps: 5_000, cap: null }, 100n)).toBe(100n);
    const rs300 = { kind: 'fixed_amount', amount: 300_00n } as const;
    expect(off(rs300, 4_000_00n)).toBe(300_00n);
    expect(off(rs300, 200_00n)).toBe(200_00n);
    expect(off(rs300, 0n)).toBe(0n);
  });
});

describe.skipIf(!server)('Something off for paying by transfer', () => {
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

  /**
   * Places an order for a kurta, with Rs 250 delivery, as checkout does: `discount` off it, of
   * which `transferDiscount` for paying by transfer.
   */
  function place(paymentMethod: PaymentMethodValue, discount: bigint, transferDiscount: bigint) {
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
          lines: [{ variantId: kurta, quantity: 1, price: null }],
          address,
          email: null,
          paymentMethod,
          shipping: 250_00n,
          discount,
          transferDiscount,
          discountCodes: discount > transferDiscount ? ['EID10'] : [],
          advance: 0n,
          locationId: null,
          note: '',
          tags: [],
        },
      ),
    );
  }

  it("keeps the shop's discount for paying by transfer, checked, and who changed it to what", async () => {
    const update = (discount: TransferDiscountInput | null) =>
      f.bankTransfer.update(f.a, { discount });
    // A percentage or an amount, and a cap only with a percentage.
    expect(errorsOf(await update({}))).toEqual([['input.discount.percentage', 'BLANK']]);
    expect(errorsOf(await update({ percentage: 5, amount: '100' }))).toEqual([
      ['input.discount.amount', 'INVALID'],
    ]);
    expect(errorsOf(await update({ amount: '100', cap: '50' }))).toEqual([
      ['input.discount.cap', 'INVALID'],
    ]);
    for (const percentage of [0, 50.01, 2.555]) {
      expect(errorsOf(await update({ percentage }))).toEqual([
        ['input.discount.percentage', 'INVALID'],
      ]);
    }
    expect(errorsOf(await update({ percentage: 5, cap: '0' }))).toEqual([
      ['input.discount.cap', 'INVALID'],
    ]);
    expect(errorsOf(await update({ amount: '0' }))).toEqual([['input.discount.amount', 'INVALID']]);
    expect((await f.bankTransfer.get(f.a)).discount).toBeNull();

    await f.admin.query('DELETE FROM platform.outbox_events; DELETE FROM platform.audit_log');
    // Kept while transfers are off: checkout takes it off once they are on.
    expect(unwrap(await update({ percentage: 5, cap: '500' })).discount).toEqual({
      kind: 'percentage',
      percentageBps: 500,
      cap: 500_00n,
    });
    // The same again changes nothing.
    unwrap(await update({ percentage: 5.0, cap: '500.00' }));
    expect(unwrap(await update({ amount: '150', cap: '' })).discount).toEqual({
      kind: 'fixed_amount',
      amount: 150_00n,
    });
    expect(unwrap(await update(null)).discount).toBeNull();

    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'bank_transfer_settings.updated')
        .map((event) => event.payload),
    ).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ changed: ['discount'] })));
    const { rows } = await f.admin.query<{ details: { discount: unknown; before: unknown } }>(
      'SELECT details FROM platform.audit_log ORDER BY id',
    );
    const percentage = { percentage: 5, cap: '500.00' };
    const amount = { amount: '150.00' };
    expect(rows.map((row) => [row.details.discount, row.details.before])).toEqual([
      [percentage, { enabled: false, account: null, discount: null }],
      [amount, { enabled: false, account: null, discount: percentage }],
      [null, { enabled: false, account: null, discount: amount }],
    ]);
  });

  it('keeps it apart from the codes, on the invoice, in the export and on the customer’s page', async () => {
    // Rs 200 off by a code, then Rs 100 for paying by transfer.
    const order = unwrap(await place('bank_transfer', 300_00n, 100_00n));
    expect(order).toMatchObject({
      subtotal: 2_000_00n,
      discount: 300_00n,
      transferDiscount: 100_00n,
      shipping: 250_00n,
      total: 1_950_00n,
    });
    // Only a transfer has it, and it is part of the order's discount.
    await expect(place('cash_on_delivery', 100_00n, 100_00n)).rejects.toThrow(
      'Only an order paid by bank transfer has a discount for it',
    );
    await expect(place('bank_transfer', 0n, 100_00n)).rejects.toThrow(
      "The discount for paying by transfer is part of the order's discount",
    );

    const invoice = unwrap(
      await f.documents.render(f.a, [order.id], {
        kind: 'invoice',
        paper: 'a4',
        language: 'english',
      }),
    );
    expect(invoice.html).toMatch(
      /Discount<\/td>\s*<td class="num">\s*<bdi dir="ltr">-Rs 200<\/bdi>[\s\S]*?Bank transfer discount<\/td>\s*<td class="num"><bdi dir="ltr">-Rs 100<\/bdi>/,
    );

    const [header, row] = parseCsv(unwrap(await f.exports.export(f.a, { layout: 'orders' })).csv);
    const cell = (name: string) => row![header!.indexOf(name)];
    expect([cell('Discount'), cell('Transfer discount'), cell('Total')]).toEqual([
      '300.00',
      '100.00',
      '1950.00',
    ]);

    const link = unwrap(await f.links.createLink(f.a, order.id));
    const view = await f.links.viewLink(link.url.split('/o/')[1]!);
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
    expect(orderLinkPage(view).html).toMatch(
      /Discount<\/span>[\s\S]*?-Rs 200[\s\S]*?Bank transfer discount<\/span>[\s\S]*?-Rs 100[\s\S]*?Pay by bank transfer<\/span>[\s\S]*?Rs 1,950/,
    );
  });
});
