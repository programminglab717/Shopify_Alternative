import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import {
  FulfillmentService,
  OrderEvents,
  RefundService,
  type OrderService,
} from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CashbackRewards, cashbackCreditId } from './cashback.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();
const DAY = 86_400_000;

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

const SHOP: TenantContext = {
  shopId: newId(),
  currency: 'PKR',
  actor: { kind: 'app', tokenId: newId() },
  scopes: new Set(['write_products', 'write_inventory', 'write_orders']),
};

describe.skipIf(!server)('Cashback on delivered, paid orders (PAY-13, ADR-453)', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let orders: OrderService;
  let fulfillments: FulfillmentService;
  let rewards: CashbackRewards;
  let refunds: RefundService;
  let variantId = '';
  let cardId = '';
  let phones = 0;

  /** An order of `quantity` kurtas at Rs 2,345, and `cards` gift cards, paid by cash on delivery. */
  async function ordered(quantity = 1, cards = 0): Promise<string> {
    const order = unwrap(
      await orders.create(SHOP, {
        lineItems: [
          { variantId, quantity },
          ...(cards ? [{ variantId: cardId, quantity: cards }] : []),
        ],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: `0300 44433${String(phones++).padStart(2, '0')}`,
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
        paymentMethod: 'cash_on_delivery',
      }),
    );
    unwrap(await orders.confirm(SHOP, order.id));
    return order.id;
  }

  /** Its parcel delivered: what the worker hears of it. */
  async function delivered(orderId: string): Promise<void> {
    const { fulfillmentId } = unwrap(await fulfillments.fulfill(SHOP, orderId, {}));
    unwrap(await fulfillments.markDelivered(SHOP, fulfillmentId));
    await hear(OrderEvents.FulfillmentUpdated, fulfillmentId, {
      orderId,
      status: 'delivered',
      changed: ['status'],
    });
  }

  const hear = (type: string, aggregateId: string, payload: Record<string, unknown> = {}) =>
    rewards.handle({
      id: newId(),
      type,
      shopId: SHOP.shopId,
      aggregateType: type === OrderEvents.FulfillmentUpdated ? 'fulfillment' : 'order',
      aggregateId,
      payload,
      occurredAt: new Date().toISOString(),
    });

  const credits = async (orderId: string) =>
    (
      await admin.query<{ id: string; amount: string; note: string; expires_at: Date }>(
        `SELECT id, amount::text, note, expires_at FROM customers.store_credit_transactions
          WHERE order_id = $1 AND kind = 'credit' ORDER BY created_at`,
        [orderId],
      )
    ).rows;

  const turn = (enabled: boolean, percent = 5, days = 90) =>
    admin.query(
      `INSERT INTO messaging.automations (shop_id, kind, enabled, cashback_percent, credit_days)
       VALUES ($1, 'cashback', $2, $3, $4)
       ON CONFLICT (shop_id, kind) DO UPDATE
          SET enabled = $2, cashback_percent = $3, credit_days = $4`,
      [SHOP.shopId, enabled, percent, days],
    );

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'cashback-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [SHOP.shopId]);
    orders = workerOrders(database);
    fulfillments = new FulfillmentService(database, new StockService());
    rewards = new CashbackRewards(database);
    refunds = new RefundService(database);
    const product = unwrap(
      await new ProductService(database).create(SHOP, {
        title: 'Kurta',
        status: 'active',
        variants: [{ price: '2,345' }],
      }),
    );
    variantId = product.variants[0]!.id;
    cardId = unwrap(
      await new ProductService(database).create(SHOP, {
        title: 'Gift card',
        status: 'active',
        giftCard: true,
        variants: [{ price: '5,000' }],
      }),
    ).variants[0]!.id;
    const location = await new LocationService(database).primary(SHOP);
    unwrap(
      await new InventoryService(database, new VariantService(database)).setQuantities(SHOP, {
        name: 'on_hand',
        reason: 'received',
        quantities: [
          { inventoryItemId: variantId, locationId: location.id, quantity: 50 },
          { inventoryItemId: cardId, locationId: location.id, quantity: 50 },
        ],
      }),
    );
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("gives a share of the goods once the order is delivered and paid, once, lasting the recipe's days", async () => {
    await turn(true, 5, 30);
    const orderId = await ordered(2);
    // Delivered, the cash not yet recorded: nothing yet.
    await delivered(orderId);
    expect(await credits(orderId)).toEqual([]);
    // Paid: 5% of Rs 4,690 is Rs 234.50, given as Rs 234.
    unwrap(await orders.markAsPaid(SHOP, orderId));
    const at = new Date();
    expect(await hear(OrderEvents.OrderPaid, orderId)).toBe(234_00n);
    // Heard again, by either event: given once.
    await hear(OrderEvents.OrderPaid, orderId);
    await hear(OrderEvents.FulfillmentUpdated, newId(), { orderId, status: 'delivered' });
    const { rows } = await admin.query<{ number: number }>(
      'SELECT number FROM orders.orders WHERE id = $1',
      [orderId],
    );
    const given = await credits(orderId);
    expect(given).toEqual([
      {
        id: cashbackCreditId(orderId),
        amount: '23400',
        note: `Cashback: 5% of order #${rows[0]!.number}`,
        expires_at: expect.any(Date),
      },
    ]);
    expect(Math.abs(given[0]!.expires_at.getTime() - (at.getTime() + 30 * DAY))).toBeLessThan(
      60_000,
    );
    // Its customer hears of it as of any credit (ADR-192).
    const { rows: told } = await admin.query(
      `SELECT 1 FROM platform.outbox_events
        WHERE shop_id = $1 AND event_type = 'store_credit.credited'`,
      [SHOP.shopId],
    );
    expect(told).toHaveLength(1);
  });

  it('gives nothing while off, before delivery, or for an order cancelled', async () => {
    await turn(false);
    const off = await ordered();
    unwrap(await orders.markAsPaid(SHOP, off));
    await delivered(off);
    await hear(OrderEvents.OrderPaid, off);
    expect(await credits(off)).toEqual([]);

    await turn(true);
    const unsent = await ordered();
    unwrap(await orders.markAsPaid(SHOP, unsent));
    expect(await hear(OrderEvents.OrderPaid, unsent)).toBeNull();
    // A parcel heard of as on its way says nothing of delivery.
    expect(
      await hear(OrderEvents.FulfillmentUpdated, newId(), {
        orderId: unsent,
        status: 'in_transit',
      }),
    ).toBeNull();

    const cancelled = await ordered();
    unwrap(await orders.markAsPaid(SHOP, cancelled));
    unwrap(await orders.cancel(SHOP, cancelled, { reason: 'customer' }));
    expect(await hear(OrderEvents.OrderPaid, cancelled)).toBeNull();
    expect(await credits(unsent)).toEqual([]);
    expect(await credits(cancelled)).toEqual([]);
  });

  it('gives none for gift cards: a card is money, not goods (ADR-805)', async () => {
    await turn(true, 10, 30);
    const orderId = await ordered(2, 1);
    unwrap(await orders.markAsPaid(SHOP, orderId));
    await delivered(orderId);
    // 10% of the kurtas' Rs 4,690, not of the card's Rs 5,000.
    expect(await hear(OrderEvents.OrderPaid, orderId)).toBe(469_00n);
  });

  it('takes back the share of cashback a refund took, from what is left of that credit (ADR-805)', async () => {
    await turn(true, 10, 30);
    const orderId = await ordered(2);
    unwrap(await orders.markAsPaid(SHOP, orderId));
    await delivered(orderId);
    expect(await hear(OrderEvents.OrderPaid, orderId)).toBe(469_00n);
    const taken = async () =>
      (
        await admin.query<{ amount: string; note: string }>(
          `SELECT amount::text, note FROM customers.store_credit_transactions
            WHERE order_id = $1 AND kind = 'debit' ORDER BY created_at`,
          [orderId],
        )
      ).rows;
    // A kurta of the two came back: Rs 2,345 of Rs 4,690, half its cashback with it.
    unwrap(await refunds.refund(SHOP, orderId, { amount: '2,345', method: 'cash' }));
    expect(await hear(OrderEvents.OrderRefunded, orderId)).toBe(-235_00n);
    // Heard again: nothing more.
    expect(await hear(OrderEvents.OrderRefunded, orderId)).toBeNull();
    const { rows } = await admin.query<{ number: number; remaining: string }>(
      `SELECT o.number, c.remaining::text FROM orders.orders o
         JOIN customers.store_credit_transactions c ON c.id = $2
        WHERE o.id = $1`,
      [orderId, cashbackCreditId(orderId)],
    );
    expect(rows[0]!.remaining).toBe('23400');
    expect(await taken()).toEqual([
      { amount: '23500', note: `Cashback taken back: order #${rows[0]!.number} refunded` },
    ]);
    // Its customer spent Rs 200 of what was left; then the rest came back: what they spent stays
    // theirs.
    await admin.query(
      `UPDATE customers.store_credit_transactions SET remaining = remaining - 20000
        WHERE id = $1`,
      [cashbackCreditId(orderId)],
    );
    unwrap(await refunds.refund(SHOP, orderId, { amount: '2,345', method: 'cash' }));
    expect(await hear(OrderEvents.OrderRefunded, orderId)).toBe(-34_00n);
    expect((await taken()).map((row) => row.amount)).toEqual(['23500', '3400']);
  });

  it('takes back nothing of an order that earned no cashback', async () => {
    await turn(true);
    const orderId = await ordered();
    unwrap(await orders.markAsPaid(SHOP, orderId));
    unwrap(await refunds.refund(SHOP, orderId, { amount: '2,345', method: 'cash' }));
    expect(await hear(OrderEvents.OrderRefunded, orderId)).toBeNull();
  });

  it('makes the same credit ID of an order however often asked, a UUID of its own', () => {
    const id = newId();
    expect(cashbackCreditId(id)).toBe(cashbackCreditId(id));
    expect(cashbackCreditId(id)).not.toBe(cashbackCreditId(newId()));
    expect(cashbackCreditId(id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
