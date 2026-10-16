import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { giftCardDigest, normalizeGiftCardCode } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { MessagesService } from '@hatti/messaging/public';
import { OrderEvents, type OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GiftCardSales } from './gift-card-sales.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

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

describe.skipIf(!server)('Gift cards sold as products (CAT-12, ADR-451)', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let orders: OrderService;
  let sales: GiftCardSales;
  let card = '';
  let kurta = '';
  let phones = 0;

  /** An order of `cards` gift cards and a kurta, paid by cash on delivery. */
  async function ordered(cards: number): Promise<string> {
    const order = unwrap(
      await orders.create(SHOP, {
        lineItems: [
          { variantId: card, quantity: cards },
          { variantId: kurta, quantity: 1 },
        ],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: `0300 55566${String(phones++).padStart(2, '0')}`,
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
        paymentMethod: 'cash_on_delivery',
      }),
    );
    return order.id;
  }

  /** Its payment heard, as the outbox hands it on. */
  const paid = (orderId: string) =>
    sales.handle({
      id: newId(),
      type: OrderEvents.OrderPaid,
      shopId: SHOP.shopId,
      aggregateType: 'order',
      aggregateId: orderId,
      payload: {},
      occurredAt: new Date().toISOString(),
    });

  const cardsOf = async (orderId: string) =>
    (
      await admin.query<{
        id: string;
        code_hash: Buffer;
        initial_value: string;
        balance: string;
        note: string;
        customer_id: string | null;
        line_unit: number;
      }>(
        `SELECT id, code_hash, initial_value::text, balance::text, note, customer_id, line_unit
           FROM customers.gift_cards WHERE order_id = $1 ORDER BY line_unit`,
        [orderId],
      )
    ).rows;

  const messagesOf = async (orderId: string) =>
    (
      await admin.query<{
        dedupe_key: string;
        recipient: string;
        variables: Record<string, string>;
      }>(
        `SELECT dedupe_key, recipient, variables FROM messaging.messages
          WHERE kind = 'gift_card' AND order_id = $1 ORDER BY created_at, id`,
        [orderId],
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'gift-card-sales-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [SHOP.shopId]);
    orders = workerOrders(database);
    sales = new GiftCardSales(database, new MessagesService(database));
    const products = new ProductService(database);
    const location = await new LocationService(database).primary(SHOP);
    const inventory = new InventoryService(database, new VariantService(database));
    for (const [title, giftCard, price] of [
      ['Eid gift card', true, '5,000'],
      ['Kurta', false, '2,000'],
    ] as const) {
      const product = unwrap(
        await products.create(SHOP, { title, status: 'active', giftCard, variants: [{ price }] }),
      );
      const variantId = product.variants[0]!.id;
      if (giftCard) card = variantId;
      else kurta = variantId;
      unwrap(
        await inventory.setQuantities(SHOP, {
          name: 'on_hand',
          reason: 'received',
          quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 20 }],
        }),
      );
    }
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('issues a card for each unit once the order is paid in full, and sends each its code once', async () => {
    const orderId = await ordered(2);
    // Not paid yet, then paid in part: no card.
    await paid(orderId);
    unwrap(await orders.recordPayment(SHOP, orderId, { amount: '1,000' }));
    await paid(orderId);
    expect(await cardsOf(orderId)).toEqual([]);

    unwrap(await orders.markAsPaid(SHOP, orderId));
    // Heard twice: the cards are issued once.
    await paid(orderId);
    await paid(orderId);
    const cards = await cardsOf(orderId);
    const { rows } = await admin.query<{ number: number; customer_id: string }>(
      'SELECT number, customer_id FROM orders.orders WHERE id = $1',
      [orderId],
    );
    const { number, customer_id: customerId } = rows[0]!;
    expect(cards).toEqual(
      [1, 2].map((unit) => ({
        id: expect.any(String),
        code_hash: expect.any(Buffer),
        initial_value: '500000',
        balance: '500000',
        note: `Order #${number}`,
        customer_id: customerId,
        line_unit: unit,
      })),
    );
    const messages = await messagesOf(orderId);
    expect(messages.map((message) => message.dedupe_key)).toEqual(
      cards.map((each) => `gift_card:${each.id}`),
    );
    for (const [index, message] of messages.entries()) {
      expect(message.recipient).toBe('+923005556600');
      expect(message.variables).toMatchObject({ shop: 'Zari', amount: 'Rs 5,000' });
      // The code is the card's: the digest it is kept as, in groups of four.
      expect(message.variables.code).toMatch(/^([A-Z2-9]{4} ){3}[A-Z2-9]{4}$/);
      expect(giftCardDigest(normalizeGiftCardCode(message.variables.code!))).toEqual(
        cards[index]!.code_hash,
      );
    }
    const { rows: ledger } = await admin.query<{ kind: string; actor_kind: string }>(
      `SELECT kind, actor_kind FROM customers.gift_card_transactions WHERE order_id = $1`,
      [orderId],
    );
    expect(ledger).toEqual([
      { kind: 'issue', actor_kind: 'system' },
      { kind: 'issue', actor_kind: 'system' },
    ]);
  });

  it('issues nothing for an order cancelled, or one without a gift card', async () => {
    const cancelled = await ordered(1);
    unwrap(await orders.markAsPaid(SHOP, cancelled));
    unwrap(await orders.cancel(SHOP, cancelled, { reason: 'customer' }));
    await paid(cancelled);
    expect(await cardsOf(cancelled)).toEqual([]);

    const plain = unwrap(
      await orders.create(SHOP, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: {
          name: 'Bilal',
          phone: '0300 5556699',
          address1: 'House 1',
          city: 'Lahore',
        },
        paymentMethod: 'cash_on_delivery',
      }),
    );
    unwrap(await orders.markAsPaid(SHOP, plain.id));
    await paid(plain.id);
    expect(await cardsOf(plain.id)).toEqual([]);
    expect(await messagesOf(plain.id)).toEqual([]);
  });
});
