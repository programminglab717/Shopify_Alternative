import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { CustomerService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { referralCodeIn } from '@hatti/messaging/public';
import { FulfillmentService, OrderEvents, type OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReferralRewards, referralCreditId } from './referrals.js';
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

/** Where an order came from: its address online and browser. */
interface From {
  ip?: string;
  agent?: string;
  ref?: string | null;
  address1?: string;
}

describe.skipIf(!server)(
  "Referrals, rewarded once a friend's first order arrives (MKT-07, ADR-807)",
  () => {
    let testDb: TestDatabase;
    let database: Database;
    let admin: pg.Client;
    let orders: OrderService;
    let fulfillments: FulfillmentService;
    let rewards: ReferralRewards;
    let variantId = '';
    let streets = 0;

    /**
     * An order of a kurta at Rs 2,345 by the customer of `phone`, delivered and paid by cash on
     * delivery, placed from `from`: a link with `from.ref`, if given.
     */
    async function received(phone: string, from: From = {}): Promise<string> {
      const order = unwrap(
        await orders.create(SHOP, {
          lineItems: [{ variantId, quantity: 1 }],
          shippingAddress: {
            name: 'Ayesha Khan',
            phone,
            address1: from.address1 ?? `House ${++streets}, Street 4`,
            city: 'Lahore',
          },
          paymentMethod: 'cash_on_delivery',
        }),
      );
      const landing = `https://zari.example/products/kurta${from.ref ? `?ref=${from.ref}` : ''}`;
      const visit = {
        at: new Date().toISOString(),
        source: 'whatsapp',
        utm: null,
        landingPage: landing,
      };
      await admin.query(
        `UPDATE orders.orders SET attribution = $2, client_ip = $3, client_user_agent = $4
        WHERE id = $1`,
        [
          order.id,
          JSON.stringify({ first: visit, last: visit }),
          from.ip ?? `10.0.0.${++streets}`,
          from.agent ?? 'Mozilla/5.0 (Linux; Android 14)',
        ],
      );
      unwrap(await orders.confirm(SHOP, order.id));
      unwrap(await orders.markAsPaid(SHOP, order.id));
      const { fulfillmentId } = unwrap(await fulfillments.fulfill(SHOP, order.id, {}));
      unwrap(await fulfillments.markDelivered(SHOP, fulfillmentId));
      return order.id;
    }

    const hear = (orderId: string) =>
      rewards.handle({
        id: newId(),
        type: OrderEvents.OrderPaid,
        shopId: SHOP.shopId,
        aggregateType: 'order',
        aggregateId: orderId,
        payload: {},
        occurredAt: new Date().toISOString(),
      });

    const customerOf = async (orderId: string) =>
      (
        await admin.query<{ customer_id: string }>(
          'SELECT customer_id FROM orders.orders WHERE id = $1',
          [orderId],
        )
      ).rows[0]!.customer_id;

    /** A customer who has had an order delivered and paid, and their code. */
    async function referrer(phone: string, from: From = {}): Promise<{ id: string; code: string }> {
      const id = await customerOf(await received(phone, from));
      const code = (await database.tenant(SHOP.shopId, (tx) =>
        referralCodeIn(tx, SHOP.shopId, id),
      ))!;
      return { id, code };
    }

    const program = (enabled: boolean, friendCredit = 200_00, minimumOrder = 0) =>
      admin.query(
        `INSERT INTO messaging.referral_programs
              (shop_id, enabled, referrer_credit, friend_credit, credit_days, minimum_order)
       VALUES ($1, $2, 30000, $3, 60, $4)
       ON CONFLICT (shop_id) DO UPDATE
          SET enabled = $2, friend_credit = $3, minimum_order = $4`,
        [SHOP.shopId, enabled, friendCredit, minimumOrder],
      );

    const credit = async (id: string) =>
      (
        await admin.query<{ customer_id: string; amount: string; note: string }>(
          `SELECT a.customer_id, t.amount::text, t.note
           FROM customers.store_credit_transactions t
           JOIN customers.store_credit_accounts a ON a.id = t.account_id
          WHERE t.id = $1`,
          [id],
        )
      ).rows[0] ?? null;

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      database = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'referrals-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [SHOP.shopId]);
      orders = workerOrders(database);
      fulfillments = new FulfillmentService(database, new StockService());
      rewards = new ReferralRewards(database);
      const product = unwrap(
        await new ProductService(database).create(SHOP, {
          title: 'Kurta',
          status: 'active',
          variants: [{ price: '2,345' }],
        }),
      );
      variantId = product.variants[0]!.id;
      const location = await new LocationService(database).primary(SHOP);
      unwrap(
        await new InventoryService(database, new VariantService(database)).setQuantities(SHOP, {
          name: 'on_hand',
          reason: 'received',
          quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 100 }],
        }),
      );
    });

    afterAll(async () => {
      await database?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('gives both store credit once the friend’s first order from the link arrives, once', async () => {
      await program(true);
      const sana = await referrer('0300 5550001');
      const orderId = await received('0300 5550002', { ref: sana.code.toLowerCase() });
      expect(await hear(orderId)).toEqual({ rewarded: true });
      // Heard again: dealt with already.
      expect(await hear(orderId)).toBeNull();
      const { rows } = await admin.query<{ number: number }>(
        'SELECT number FROM orders.orders WHERE id = $1',
        [orderId],
      );
      expect(await credit(referralCreditId(orderId, 'referrer'))).toEqual({
        customer_id: sana.id,
        amount: '30000',
        note: `Referral: a friend's first order, #${rows[0]!.number}`,
      });
      expect(await credit(referralCreditId(orderId, 'friend'))).toEqual({
        customer_id: await customerOf(orderId),
        amount: '20000',
        note: `Referral: welcome, for order #${rows[0]!.number}`,
      });
      const { rows: kept } = await admin.query(
        `SELECT outcome, reason, referrer_credit::text, friend_credit::text
         FROM messaging.referrals WHERE order_id = $1`,
        [orderId],
      );
      expect(kept).toEqual([
        { outcome: 'rewarded', reason: null, referrer_credit: '30000', friend_credit: '20000' },
      ]);
    });

    it('refuses what the checks against fraud find, and keeps why', async () => {
      await program(true);
      const sana = await referrer('0300 5550011', {
        ip: '203.0.113.7',
        agent: 'Mozilla/5.0 (iPhone)',
        address1: 'House 9, Street 2, Model Town',
      });
      const refused = async (phone: string, from: From) => {
        const orderId = await received(phone, { ref: sana.code, ...from });
        const outcome = await hear(orderId);
        expect(await credit(referralCreditId(orderId, 'referrer'))).toBeNull();
        return outcome;
      };
      // Their own order from their own link.
      expect(await refused('0300 5550011', {})).toEqual({ rewarded: false, reason: 'own_code' });
      // From their phone: the same address online and browser.
      expect(
        await refused('0300 5550012', { ip: '203.0.113.7', agent: 'Mozilla/5.0 (iPhone)' }),
      ).toEqual({ rewarded: false, reason: 'same_device' });
      // To their house, written otherwise.
      expect(await refused('0300 5550013', { address1: 'house 9 street 2,  MODEL TOWN' })).toEqual({
        rewarded: false,
        reason: 'same_address',
      });
      // A customer of the shop already.
      const before = '0300 5550014';
      await received(before);
      expect(await refused(before, {})).toEqual({ rewarded: false, reason: 'not_first_order' });
      // Below what the programme asks of an order.
      await program(true, 200_00, 5_000_00);
      expect(await refused('0300 5550015', {})).toEqual({
        rewarded: false,
        reason: 'below_minimum',
      });
    });

    it('refuses a referrer with no order of their own, and past the month’s ten', async () => {
      await program(true, 0);
      // A code given to a customer who never had an order delivered.
      const hina = unwrap(
        await new CustomerService(database).create(SHOP, { phone: '0300 5550020', name: 'Hina' }),
      );
      const unproven = (await database.tenant(SHOP.shopId, (tx) =>
        referralCodeIn(tx, SHOP.shopId, hina.id),
      ))!;
      const orderId = await received('0300 5550021', { ref: unproven });
      expect(await hear(orderId)).toEqual({ rewarded: false, reason: 'referrer_unproven' });

      const sana = await referrer('0300 5550022');
      for (let friend = 0; friend < 10; friend++) {
        const each = await received(`0300 55501${String(friend).padStart(2, '0')}`, {
          ref: sana.code,
        });
        expect(await hear(each)).toEqual({ rewarded: true });
        // No credit for the friend where the programme gives them none.
        expect(await credit(referralCreditId(each, 'friend'))).toBeNull();
      }
      const eleventh = await received('0300 5550199', { ref: sana.code });
      expect(await hear(eleventh)).toEqual({ rewarded: false, reason: 'monthly_limit' });
    });

    it('does nothing while off, before delivery, or for an order from no link', async () => {
      const sana = await referrer('0300 5550031');
      await program(false);
      expect(await hear(await received('0300 5550032', { ref: sana.code }))).toBeNull();
      await program(true);
      expect(await hear(await received('0300 5550033'))).toBeNull();
      expect(await hear(await received('0300 5550034', { ref: 'NOSUCHCD' }))).toBeNull();
      const { rows } = await admin.query(
        'SELECT 1 FROM messaging.referrals WHERE referrer_id = $1',
        [sana.id],
      );
      expect(rows).toEqual([]);
    });

    it('makes the same credit ID of an order and side however often asked', () => {
      const id = newId();
      expect(referralCreditId(id, 'referrer')).toBe(referralCreditId(id, 'referrer'));
      expect(referralCreditId(id, 'referrer')).not.toBe(referralCreditId(id, 'friend'));
    });
  },
);
