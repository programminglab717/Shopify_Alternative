import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PastOrderService, majorOf, type PastOrderInput } from './past-orders.js';
import { ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

/** An order from the shop's Shopify store, as the import gives it. */
const shopified = (name: string, extra: Partial<PastOrderInput> = {}): PastOrderInput => ({
  sourceId: `gid://shopify/Order/${name.slice(1)}`,
  name,
  phone: '0300 1234567',
  email: 'ayesha@example.pk',
  placedAt: new Date('2025-03-20T09:00:00Z'),
  cancelledAt: null,
  currency: 'PKR',
  subtotal: 900_000n,
  shipping: 25_000n,
  discounts: 50_000n,
  total: 875_000n,
  financialStatus: 'PAID',
  fulfillmentStatus: 'FULFILLED',
  lines: [{ title: 'Lawn suit', variantTitle: 'M', sku: 'LAWN-M', quantity: 2, price: 450_000n }],
  shippingAddress: {
    name: 'Ayesha Khan',
    phone: '0300 1234567',
    address1: 'House 12, Street 4',
    address2: 'Gulberg',
    city: 'Lahore',
    province: 'Punjab',
    zip: '54000',
    countryCode: 'PK',
  },
  note: 'Leave with the guard',
  ...extra,
});

describe.skipIf(!server)('Past orders from the store a shop moved from (ONB-05, ADR-786)', () => {
  let f: OrdersFixture;
  let past: PastOrderService;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    past = new PastOrderService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('keeps each once, naming the customer its number is, the latest placed first', async () => {
    const ayesha = unwrap(await f.customers.create(f.a, { phone: '0300 1234567', name: 'Ayesha' }));
    const orders = [
      shopified('#1001'),
      shopified('#1002', {
        phone: '+44 20 7946 0000',
        email: null,
        placedAt: new Date('2025-04-01T09:00:00Z'),
        cancelledAt: new Date('2025-04-02T09:00:00Z'),
        shippingAddress: null,
      }),
    ];
    expect(await past.bring(f.a, 'shopify', orders)).toEqual({ added: 2, linked: 1 });
    // Brought again, each is kept once.
    expect(await past.bring(f.a, 'shopify', orders)).toEqual({ added: 0, linked: 0 });

    const page = await past.list(f.a, { first: 1 });
    expect(page.hasNextPage).toBe(true);
    expect(page.items[0]).toMatchObject({
      name: '#1002',
      customerId: null,
      phone: '+44 20 7946 0000',
      cancelledAt: new Date('2025-04-02T09:00:00Z'),
    });
    const [first] = (await past.list(f.a, { first: 5, after: page.items[0]!.id })).items;
    expect(first).toMatchObject({
      source: 'shopify',
      name: '#1001',
      customerId: ayesha.id,
      phone: '+923001234567',
      total: 875_000n,
      lines: [
        { title: 'Lawn suit', variantTitle: 'M', sku: 'LAWN-M', quantity: 2, price: 450_000n },
      ],
      shippingAddress: { city: 'Lahore', countryCode: 'PK' },
    });
    expect((await past.list(f.a, { first: 5, customerId: ayesha.id })).items).toHaveLength(1);
    expect((await past.get(f.a, first!.id))?.name).toBe('#1001');
    // Another shop's are not its.
    expect((await past.list(f.b, { first: 5 })).items).toEqual([]);
    expect(await past.get(f.b, first!.id)).toBeNull();
    expect(await past.list(f.a, { first: 5, after: 'nope' })).toEqual({
      items: [],
      hasNextPage: false,
    });
    // Nothing of Hatti's own orders: no order, no event.
    const { rows } = await f.admin.query('SELECT 1 FROM orders.orders');
    expect(rows).toEqual([]);
    expect(await f.outbox()).not.toContainEqual(
      expect.objectContaining({ event_type: expect.stringMatching(/^order\./) as unknown }),
    );
  });

  it("follows a merge, is given in the customer's file, and keeps only the amounts once they are erased", async () => {
    const ayesha = unwrap(await f.customers.create(f.a, { phone: '0300 1234567', name: 'Ayesha' }));
    const other = unwrap(await f.customers.create(f.a, { phone: '0311 1234567', name: 'A. Khan' }));
    await past.bring(f.a, 'shopify', [shopified('#1001', { phone: '0311 1234567' })]);
    unwrap(await f.customerData.merge(f.a, ayesha.id, other.id));
    expect((await past.list(f.a, { first: 5, customerId: ayesha.id })).items).toHaveLength(1);

    const file = JSON.parse(unwrap(await f.customerData.export(f.a, ayesha.id)).json) as {
      pastOrders: unknown[];
    };
    expect(file.pastOrders).toEqual([
      expect.objectContaining({ name: '#1001', total: '8750.00', note: 'Leave with the guard' }),
    ]);

    unwrap(await f.customerData.erase(f.a, ayesha.id));
    const [kept] = (await past.list(f.a, { first: 5 })).items;
    expect(kept).toMatchObject({
      phone: null,
      email: null,
      note: '',
      total: 875_000n,
      lines: [{ title: 'Lawn suit', quantity: 2 }],
      shippingAddress: {
        name: null,
        phone: null,
        address1: null,
        city: 'Lahore',
        province: 'Punjab',
        countryCode: 'PK',
      },
    });
    expect(kept!.customerErasedAt).toBeInstanceOf(Date);
  });

  it('writes amounts in major units, as the currency has them', () => {
    expect(majorOf(875_000n, 'PKR')).toBe('8750.00');
    expect(majorOf(5n, 'PKR')).toBe('0.05');
    expect(majorOf(-1_250n, 'USD')).toBe('-12.50');
    expect(majorOf(1_000n, 'INR')).toBe('10.00');
  });
});
