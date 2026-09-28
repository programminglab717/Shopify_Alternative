import 'reflect-metadata';
import { SegmentQueryError } from '@hatti/customers/public';
import { parseCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADDRESS, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Segments over orders', () => {
  let f: OrdersFixture;
  let kurta: string;
  const people = { ayesha: '', bilal: '', sana: '', fatima: '' };

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  /**
   * Ayesha in Karachi: one order delivered and paid, one waiting. Bilal in Lahore: refused at
   * the door. Sana in Multan: cancelled. Fatima: a customer who has not ordered.
   */
  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);

    const paid = await f.order(f.a, [kurta]);
    unwrap(await f.orders.confirm(f.a, paid.id));
    const { fulfillmentId: delivered } = unwrap(await f.fulfillments.fulfill(f.a, paid.id, {}));
    unwrap(await f.fulfillments.markDelivered(f.a, delivered));
    unwrap(await f.orders.markAsPaid(f.a, paid.id));
    await f.order(f.a, [kurta]);

    const refused = await f.order(f.a, [kurta], {
      shippingAddress: { ...ADDRESS, name: 'Bilal Ahmed', phone: '03335551234', city: 'lhr' },
    });
    unwrap(await f.orders.confirm(f.a, refused.id));
    const { fulfillmentId: back } = unwrap(await f.fulfillments.fulfill(f.a, refused.id, {}));
    unwrap(await f.fulfillments.markReturning(f.a, back));
    unwrap(await f.fulfillments.receiveReturn(f.a, back));

    const cancelled = await f.order(f.a, [kurta], {
      shippingAddress: { ...ADDRESS, name: 'Sana Tariq', phone: '03459876543', city: 'Multan' },
    });
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));

    const fatima = unwrap(await f.customers.create(f.a, { phone: '03217654321', name: 'Fatima' }));
    Object.assign(people, {
      ayesha: paid.customerId,
      bilal: refused.customerId,
      sana: cancelled.customerId,
      fatima: fatima.id,
    });
  });

  /** Who a query matches, by first name, newest customer first. */
  async function who(query: string): Promise<string[]> {
    const { items } = await f.segments.members(f.a, query, { first: 50 });
    const names = new Map(Object.entries(people).map(([name, id]) => [id, name]));
    return items.map((item) => names.get(item.id) ?? item.id);
  }

  it('finds customers by how many orders they placed and what they paid', async () => {
    expect(await who('number_of_orders >= 2')).toEqual(['ayesha']);
    expect(await who('number_of_orders = 0')).toEqual(['fatima']);
    expect(await who('number_of_orders BETWEEN 1 AND 1')).toEqual(['sana', 'bilal']);
    // Rs 2,000 paid on the delivered order; the cancelled and refused orders paid nothing.
    expect(await who('amount_spent >= 2000')).toEqual(['ayesha']);
    expect(await who("amount_spent > '1,999.99' AND amount_spent < 2000.01")).toEqual(['ayesha']);
    expect(await who('amount_spent = 0')).toEqual(['fatima', 'sana', 'bilal']);
  });

  it('finds customers by how their orders turned out', async () => {
    expect(await who('delivered_orders >= 1')).toEqual(['ayesha']);
    expect(await who('returned_orders >= 1')).toEqual(['bilal']);
    expect(await who('cancelled_orders > 0')).toEqual(['sana']);
    expect(
      await who('number_of_orders > 0 AND returned_orders = 0 AND cancelled_orders = 0'),
    ).toEqual(['ayesha']);
  });

  it('finds customers by where their latest order went', async () => {
    expect(await who('city = lhr')).toEqual(['bilal']);
    expect(await who("city IN (karachi, 'Multan')")).toEqual(['sana', 'ayesha']);
    // Fatima has no city, so she is not in Lahore.
    expect(await who('city != Lahore')).toEqual(['fatima', 'sana', 'ayesha']);
    expect(await who('city NOT IN (Lahore, Karachi)')).toEqual(['fatima', 'sana']);
    expect(await who('province = Punjab')).toEqual(['sana', 'bilal']);
    expect(await who('province IN (SD, KPK)')).toEqual(['ayesha']);
    await expect(f.segments.count(f.a, 'province = Narnia')).rejects.toThrow(
      new SegmentQueryError('"Narnia" is not a province or territory of Pakistan', 12),
    );
  });

  it('finds customers by when they ordered', async () => {
    expect(await who('last_order_date >= today')).toEqual(['sana', 'bilal', 'ayesha']);
    expect(await who('first_order_date < -30d')).toEqual([]);
    // Never ordered: not "ordered in the last 30 days".
    expect(await who('NOT last_order_date >= -30d')).toEqual(['fatima']);
    await f.admin.query(
      `UPDATE orders.orders SET created_at = now() - interval '90 days' WHERE customer_id = $1`,
      [people.sana],
    );
    expect(await who('number_of_orders >= 1 AND last_order_date < -60d')).toEqual(['sana']);
    expect(await who('last_order_date BETWEEN -3m AND -2m')).toEqual(['sana']);
  });

  it('mixes order and customer fields in saved segments', async () => {
    unwrap(await f.customers.update(f.a, people.ayesha, { tags: ['VIP'] }));
    const segment = unwrap(
      await f.segments.create(f.a, {
        name: 'Loyal, not refusing',
        query: '(customer_tags CONTAINS vip OR number_of_orders >= 2) AND returned_orders = 0',
      }),
    );
    expect(await who(segment.query)).toEqual(['ayesha']);
    expect(await f.segments.count(f.a, 'blocked = false AND number_of_orders >= 1')).toBe(3);

    // Another shop's customers are its own.
    expect(await f.segments.count(f.b, 'number_of_orders >= 0')).toBe(0);
    expect(await f.segments.get(f.b, segment.id)).toBeNull();
  });

  it('exports what each customer ordered', async () => {
    const { csv } = unwrap(await f.transfer.export(f.a, { query: 'number_of_orders >= 1' }));
    const [header, ...rows] = parseCsv(csv);
    expect(header!.slice(9)).toEqual([
      'Customer since',
      'Blocked',
      'Orders',
      'Amount spent',
      'First order',
      'Last order',
      'Delivered orders',
      'Returned orders',
      'Cancelled orders',
      'City',
      'Province',
      'Exported',
    ]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
    const byName = new Map(rows.map((row) => [row[2], row.slice(11, -1)]));
    expect(byName.get('Ayesha Khan')).toEqual([
      '2',
      '2000.00',
      today,
      today,
      '1',
      '0',
      '0',
      'Karachi',
      'SD',
    ]);
    expect(byName.get('Bilal Ahmed')).toEqual([
      '1',
      '0.00',
      today,
      today,
      '0',
      '1',
      '0',
      'Lahore',
      'PB',
    ]);
    expect(byName.has('Fatima')).toBe(false);
  });
});
