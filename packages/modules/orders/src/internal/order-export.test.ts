import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { parseCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { xlsxRows } from '@hatti/xlsx/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Order exports', () => {
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
    await f.admin.query('DELETE FROM platform.audit_log');
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    [size8, size9] = (await f.variantsOf(f.a, 'Peshawari Chappal', {
      sizes: ['8', '9'],
      price: '3,499',
    })) as [string, string];
    for (const variant of [kurta, size8, size9]) await f.stock(f.a, variant, 20);
  });

  /** Places the order at 01:30 on 29 September in Karachi: still the 28th in UTC. */
  const placedAt = (orderId: string, at = '2026-09-28T20:30:00Z') =>
    f.admin.query(`UPDATE orders.orders SET created_at = $2 WHERE id = $1`, [orderId, at]);

  /** The export's rows as objects by column, the header aside. */
  const rowsOf = (csv: string) => {
    const [header, ...rows] = parseCsv(csv);
    return rows.map((row) => Object.fromEntries(header!.map((name, index) => [name, row[index]])));
  };

  const staff = (role: 'accountant'): TenantContext => ({
    ...f.a,
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      authenticatedAt: new Date(),
      role,
    },
  });

  it('exports a row per order, as the caller may see it', async () => {
    const shipped = await f.order(f.a, [kurta, size8], { shippingPrice: '250', tags: ['eid'] });
    await placedAt(shipped.id);
    unwrap(await f.orders.confirm(f.a, shipped.id));
    unwrap(
      await f.fulfillments.fulfill(f.a, shipped.id, {
        tracking: { company: 'TCS', number: '779012345678' },
      }),
    );
    const prepaid = await f.order(f.a, [size9], { paymentMethod: 'prepaid' });
    await placedAt(prepaid.id, '2026-09-29T09:05:00Z');
    unwrap(await f.refunds.refund(f.a, prepaid.id, { amount: '499', method: 'cash' }));
    await f.admin.query('DELETE FROM platform.outbox_events; DELETE FROM platform.audit_log');

    const exported = unwrap(await f.exports.export(f.a, { layout: 'orders' }));
    expect(exported.csv!.startsWith('﻿Order,Order ID,Placed,Stage,')).toBe(true);
    expect(exported.rowCount).toBe(2);
    const [first, second] = rowsOf(exported.csv!);
    expect(first).toMatchObject({
      Order: `#${shipped.number}`,
      'Order ID': toPublicId('order', shipped.id),
      Placed: '2026-09-29 01:30',
      Stage: 'in_transit',
      Status: 'open',
      Confirmation: 'confirmed',
      'Financial status': 'pending',
      'Fulfillment status': 'fulfilled',
      'Payment method': 'cash_on_delivery',
      'Customer ID': toPublicId('customer', shipped.customerId),
      Name: 'Ayesha Khan',
      Phone: '0300 1234567',
      Address: 'House 12, Street 4, Block 5',
      Area: 'Gulshan-e-Iqbal',
      Landmark: 'Near Jamia Masjid',
      City: 'Karachi',
      Province: 'Sindh',
      Postcode: '75300',
      Items: '1 × Kurta; 1 × Peshawari Chappal (8)',
      Units: '2',
      Subtotal: '5499.00',
      Discount: '0.00',
      Shipping: '250.00',
      Total: '5749.00',
      'Amount paid': '0.00',
      'COD amount': '5749.00',
      Currency: 'PKR',
      Tracking: 'TCS 779012345678',
      Tags: 'eid',
      'Cancelled at': '',
    });
    expect(first!['Confirmed at']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(first!.Exported).toMatch(/^tok_\w+ \d{4}-\d{2}-\d{2}T/);
    expect(second).toMatchObject({
      Placed: '2026-09-29 14:05',
      'Financial status': 'partially_refunded',
      'Amount paid': '3499.00',
      'Amount refunded': '499.00',
      'COD amount': '0.00',
      'Risk score': '',
    });

    // Staff who see numbers masked, such as accountants, export them masked.
    const accountant = unwrap(await f.exports.export(staff('accountant'), { layout: 'orders' }));
    expect(rowsOf(accountant.csv!)[0]!.Phone).toBe('0300 ••••567');
    expect(accountant.csv).not.toMatch(/0300 1234567|\+923001234567/);
    expect(rowsOf(accountant.csv!)[0]!.Exported).toMatch(/^usr_/);

    const audit = await f.db.tenant(f.a.shopId, (tx) => listAudit(tx, f.a.shopId, { first: 5 }));
    expect(audit.items.map((item) => [item.action, item.actorRole, item.details])).toEqual([
      [
        'orders.exported',
        'accountant',
        {
          rows: 2,
          layout: 'ORDERS',
          format: 'CSV',
          query: null,
          stage: null,
          riskLevel: null,
          placedFrom: null,
          placedBefore: null,
        },
      ],
      ['orders.exported', null, expect.objectContaining({ rows: 2 })],
    ]);
    expect((await f.outbox()).map((event) => event.event_type)).toEqual([
      'order_export.created',
      'order_export.created',
    ]);
  });

  it('exports the same rows as an Excel workbook, amounts as numbers and times as dates (ADR-182)', async () => {
    const order = await f.order(f.a, [kurta, size8], { shippingPrice: '250' });
    await placedAt(order.id);
    const csv = unwrap(await f.exports.export(f.a, { layout: 'orders' }));
    expect(csv.file).toMatchObject({
      filename: expect.stringMatching(/^orders-\d{4}-\d{2}-\d{2}\.csv$/),
      contentType: 'text/csv; charset=utf-8',
    });
    expect(csv.file.content.toString('utf8')).toBe(csv.csv);

    const workbook = unwrap(await f.exports.export(f.a, { layout: 'orders', format: 'xlsx' }));
    expect(workbook).toMatchObject({ csv: null, rowCount: 1 });
    expect(workbook.file).toMatchObject({
      filename: expect.stringMatching(/^orders-\d{4}-\d{2}-\d{2}\.xlsx$/),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const [header, row] = xlsxRows(workbook.file.content);
    // The CSV's columns, each cell as a spreadsheet works with it.
    expect(header).toEqual(parseCsv(csv.csv!)[0]);
    const cell = (name: string) => row![header!.indexOf(name)] ?? null;
    expect(cell('Order')).toBe(`#${order.number}`);
    // 01:30 on 29 September in Karachi, as days since 30 December 1899.
    expect(cell('Placed')).toBe(46294.0625);
    expect([cell('Subtotal'), cell('Shipping'), cell('Total'), cell('Units')]).toEqual([
      5499, 250, 5749, 2,
    ]);
    // Numbers that begin with 0 stay text.
    expect([cell('Phone'), cell('Postcode')]).toEqual(['0300 1234567', '75300']);
    expect(cell('Confirmed at')).toBeNull();
    expect(cell('Exported')).toMatch(/^tok_\w+ \d{4}-\d{2}-\d{2}T/);

    const lines = unwrap(await f.exports.export(f.a, { layout: 'line_items', format: 'xlsx' }));
    expect(lines.file.filename).toMatch(/^order-items-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(
      xlsxRows(lines.file.content).map((line) => [line[0], line[9], line[10], line[12], line[13]]),
    ).toEqual([
      ['Order', 'Line', 'Product', 'SKU', 'Quantity'],
      [`#${order.number}`, 1, 'Kurta', null, 1],
      [`#${order.number}`, 2, 'Peshawari Chappal', 'PES-8', 1],
    ]);
    const audit = await f.db.tenant(f.a.shopId, (tx) => listAudit(tx, f.a.shopId, { first: 3 }));
    expect(audit.items.map((item) => item.details)).toEqual([
      expect.objectContaining({ rows: 2, layout: 'LINE_ITEMS', format: 'XLSX' }),
      expect.objectContaining({ rows: 1, layout: 'ORDERS', format: 'XLSX' }),
      expect.objectContaining({ rows: 1, layout: 'ORDERS', format: 'CSV' }),
    ]);
  });

  it('filters as the order list does, or lays out a row per line item', async () => {
    const early = await f.order(f.a, [kurta, size9]);
    await placedAt(early.id, '2026-09-01T10:00:00Z');
    const late = await f.order(f.a, [size8]);
    await placedAt(late.id, '2026-09-20T10:00:00Z');
    unwrap(await f.orders.confirm(f.a, late.id));
    const names = async (filter: Parameters<OrdersFixture['exports']['export']>[1]) =>
      rowsOf(unwrap(await f.exports.export(f.a, filter)).csv!).map((row) => row.Order);

    expect(await names({ layout: 'orders', stage: 'to_pack' })).toEqual([`#${late.number}`]);
    expect(await names({ layout: 'orders', query: `#${early.number}` })).toEqual([
      `#${early.number}`,
    ]);
    expect(
      await names({
        layout: 'orders',
        placedFrom: new Date('2026-09-10T00:00:00+05:00'),
        placedBefore: new Date('2026-10-01T00:00:00+05:00'),
      }),
    ).toEqual([`#${late.number}`]);
    expect(
      errorsOf(
        await f.exports.export(f.a, {
          layout: 'orders',
          placedFrom: new Date('2026-10-01'),
          placedBefore: new Date('2026-09-01'),
        }),
      ),
    ).toEqual([['placedBefore', 'INVALID']]);

    const lines = unwrap(await f.exports.export(f.a, { layout: 'line_items' }));
    expect(lines.rowCount).toBe(3);
    expect(
      rowsOf(lines.csv!).map((row) => [row.Order, row.Line, row.Product, row.Variant, row.SKU]),
    ).toEqual([
      [`#${early.number}`, '1', 'Kurta', '', ''],
      [`#${early.number}`, '2', 'Peshawari Chappal', '9', 'PES-9'],
      [`#${late.number}`, '1', 'Peshawari Chappal', '8', 'PES-8'],
    ]);
    expect(rowsOf(lines.csv!)[1]).toMatchObject({
      Quantity: '1',
      'Unit price': '3499.00',
      'Line total': '3499.00',
      Shipped: '0',
      Name: 'Ayesha Khan',
    });
  });

  it('exports at most 10,000 orders at a time', async () => {
    await f.admin.query(
      `INSERT INTO orders.orders
         (shop_id, id, number, source, confirmation_status, financial_status, stage,
          payment_method, currency, subtotal, discount, shipping, total, amount_paid, cod_amount,
          phone, shipping_address, location_id, customer_id)
       SELECT $1, platform.uuidv7(), 100000 + n, 'api', 'pending', 'pending',
              'needs_confirmation', 'cash_on_delivery', 'PKR', 1000, 0, 0, 1000, 0, 1000,
              '+923001234567', '{"city": "Karachi"}', $2, $3
         FROM generate_series(1, 10001) AS n`,
      [f.a.shopId, newId(), newId()],
    );
    expect(await f.exports.export(f.a, { layout: 'orders' })).toMatchObject({
      ok: false,
      errors: [
        {
          code: 'TOO_MANY',
          message:
            '10,001 orders match; export at most 10,000 at a time. Narrow it down, such as by ' +
            'the dates they were placed.',
        },
      ],
    });
  });
});
