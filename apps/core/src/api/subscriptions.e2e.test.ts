import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { ORDER_CUSTOMER_DATA, SubscriptionService } from '@hatti/orders/public';
import { pkDayOf } from '@hatti/pk';
import {
  cartPath,
  checkoutsPath,
  type CartChangeResponse,
  type CheckoutStartResponse,
} from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';
import { SubscriptionOrders } from '../worker/subscriptions.js';
import { workerOrders } from '../worker/unreachable-orders.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const FORM = {
  name: 'Ayesha Khan',
  phone: '0300 1234567',
  city: 'Lahore',
  address1: 'House 12, Street 4',
  address2: 'Gulberg III',
  landmark: '',
  province: '',
};

const PLAN = 'id name intervalUnit intervalCount discountPercent productTag';
const SUBSCRIPTIONS = `{ orderSubscriptions {
  id status planName interval discountPercent nextOrderOn ordersPlaced name city lastError
  originOrderId lastOrderId lines { quantity } } }`;

describe.skipIf(!server)('Subscriptions: selling plans and orders placed again (CAT-16)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  let worker: Database;
  let subscriptions: SubscriptionService;
  const shop = newId();
  let token = '';
  const asStorefront = { authorization: `Bearer ${TEST_STOREFRONT_KEY}` };

  async function data(query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: { query, variables },
    });
    const body = response.json() as { data?: Record<string, Json>; errors?: Json[] };
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  const post = (url: string, form: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form).toString(),
    });
  const shownIn = (html: string) => /name="shown" value="([\w-]{22})"/.exec(html)![1]!;

  /** Places an order through checkout of `items`: its ID. */
  async function checkout(items: object[]): Promise<{ id: string; cart: CartChangeResponse }> {
    const added = await app.inject({
      method: 'POST',
      url: cartPath(shop, 'add'),
      headers: asStorefront,
      payload: { items },
    });
    const cart = added.json() as CartChangeResponse;
    const started = await app.inject({
      method: 'POST',
      url: checkoutsPath(shop),
      headers: { ...asStorefront, 'x-hatti-cart': cart.token! },
    });
    const { path } = started.json() as CheckoutStartResponse;
    const page = await app.inject({ method: 'GET', url: path });
    const placed = await post(path, { ...FORM, shown: shownIn(page.body) });
    expect(placed.statusCode).toBe(303);
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM orders.orders ORDER BY number DESC LIMIT 1',
    );
    return { id: rows[0]!.id, cart };
  }

  /** The worker hearing the shop's `type` event of `orderId`. */
  const hear = (type: string, orderId: string) =>
    new SubscriptionOrders(subscriptions).handle({
      id: newId(),
      type,
      shopId: shop,
      aggregateType: 'order',
      aggregateId: orderId,
      payload: {},
      occurredAt: new Date().toISOString(),
    } as DomainEvent);

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    const issued = generateAccessToken();
    token = issued.token;
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, issued.hash, issued.hint, ['write_products', 'write_orders']],
    );
    api = await startTestApi(testDb);
    app = api.app;
    worker = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'subscriptions-test',
    });
    subscriptions = new SubscriptionService(
      worker,
      workerOrders(worker),
      new VariantService(worker),
    );
  });

  afterAll(async () => {
    await api?.close();
    await worker?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("subscribes a line at its plan's price, places it again, and lets the customer skip, pause and cancel", async () => {
    const tooMuch = await data(
      `mutation ($input: SellingPlanInput!) {
        sellingPlanCreate(input: $input) { sellingPlan { id } userErrors { field message } } }`,
      {
        input: {
          name: 'Every month',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          discountPercent: 60,
        },
      },
    );
    expect(tooMuch.userErrors).toEqual([
      {
        field: ['input', 'discountPercent'],
        message: 'Discount percent must be a whole number from 0 to 50',
      },
    ]);
    const made = await data(
      `mutation ($input: SellingPlanInput!) {
        sellingPlanCreate(input: $input) { sellingPlan { ${PLAN} } userErrors { message } } }`,
      {
        input: {
          name: 'Every month',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          discountPercent: 10,
          productTag: 'Subscribe',
        },
      },
    );
    const plan = made.sellingPlan;
    expect(plan).toMatchObject({
      intervalUnit: 'MONTH',
      discountPercent: 10,
      productTag: 'Subscribe',
    });

    const product = async (title: string, price: string, tags: string[]) =>
      fromPublicId(
        (
          await data(
            `mutation ($input: ProductCreateInput!) {
              productCreate(input: $input) { product { variants { id } } } }`,
            { input: { title, status: 'ACTIVE', tags, variants: [{ price }] } },
          )
        ).product.variants[0].id,
        'variant',
      );
    const chai = await product('Kashmiri chai', '1,000', ['subscribe']);
    const kurta = await product('Kurta', '2,000', []);

    // Chai is sold on the plan, the kurta isn't: its plan is no plan.
    const { id: first, cart } = await checkout([
      { variantId: chai, quantity: 2, properties: { _selling_plan: plan.id } },
      { variantId: kurta, quantity: 1, properties: { _selling_plan: plan.id } },
    ]);
    const lines = cart.cart.items;
    expect(lines.find((line) => line.variantId === chai)).toMatchObject({
      price: 90_000,
      linePrice: 180_000,
      sellingPlan: {
        id: plan.id,
        name: 'Every month',
        discountPercent: 10,
        compareAtPrice: 100_000,
      },
    });
    expect(lines.find((line) => line.variantId === kurta)).toMatchObject({ price: 200_000 });
    expect(lines.find((line) => line.variantId === kurta)!.sellingPlan).toBeUndefined();

    await hear('order.created', first);
    await hear('order.created', first);
    const [subscription] = await data(SUBSCRIPTIONS);
    const today = pkDayOf(new Date());
    expect(subscription).toMatchObject({
      status: 'ACTIVE',
      planName: 'Every month',
      interval: 'Every month',
      discountPercent: 10,
      ordersPlaced: 1,
      name: 'Ayesha Khan',
      city: 'Lahore',
      originOrderId: toPublicId('order', first),
      lines: [{ quantity: 2 }],
    });
    expect(subscription.nextOrderOn > today).toBe(true);
    expect((await data(SUBSCRIPTIONS)).length).toBe(1);

    // Due, its order is placed at the plan's price, for the same address and delivery charge.
    const due = new Date(`${subscription.nextOrderOn}T10:00:00+05:00`);
    expect(await subscriptions.placeDue(new Date(due.getTime() - 86_400_000))).toEqual({
      placed: 0,
      failed: 0,
    });
    expect(await subscriptions.placeDue(due)).toEqual({ placed: 1, failed: 0 });
    expect(await subscriptions.placeDue(due)).toEqual({ placed: 0, failed: 0 });
    const { rows: placed } = await admin.query(
      `SELECT o.id, o.tags, o.payment_method, o.shipping = f.shipping AS same_delivery,
              o.subtotal::text AS subtotal
         FROM orders.orders o, orders.orders f
        WHERE f.id = $1 AND o.id <> f.id`,
      [first],
    );
    expect(placed).toEqual([
      {
        id: expect.any(String),
        tags: ['subscription'],
        payment_method: 'cash_on_delivery',
        same_delivery: true,
        subtotal: '180000',
      },
    ]);
    const [after] = await data(SUBSCRIPTIONS);
    expect(after).toMatchObject({
      ordersPlaced: 2,
      lastOrderId: toPublicId('order', placed[0].id),
      lastError: null,
    });
    expect(after.nextOrderOn > subscription.nextOrderOn).toBe(true);

    // Its customer, on the order's page once it is confirmed, skips, pauses, resumes, cancels.
    const link = await data(
      `mutation ($id: ID!) { orderLinkCreate(id: $id) { url userErrors { message } } }`,
      { id: toPublicId('order', placed[0].id) },
    );
    const path = new URL(link.url).pathname;
    const confirming = await app.inject({ method: 'GET', url: path });
    await post(path, { action: 'confirm', shown: shownIn(confirming.body) });
    let page = await app.inject({ method: 'GET', url: path });
    expect(page.body).toContain('You subscribed: Every month, 10% off.');
    await post(path, { action: 'subscription_skip' });
    const [skipped] = await data(SUBSCRIPTIONS);
    expect(skipped.nextOrderOn > after.nextOrderOn).toBe(true);
    await post(path, { action: 'subscription_pause' });
    page = await app.inject({ method: 'GET', url: path });
    expect(page.body).toContain('is paused: no orders are placed until you resume it.');
    expect(await subscriptions.placeDue(new Date(Date.now() + 400 * 86_400_000))).toEqual({
      placed: 0,
      failed: 0,
    });
    await post(path, { action: 'subscription_resume' });
    expect((await data(SUBSCRIPTIONS))[0].status).toBe('ACTIVE');
    const cancelled = await post(path, { action: 'subscription_cancel' });
    expect(cancelled.statusCode).toBe(303);
    page = await app.inject({ method: 'GET', url: path });
    expect(page.body).toContain('is cancelled: no more orders are placed.');
    expect(page.body).not.toContain('Skip the next order');
    const again = await data(
      `mutation ($id: ID!) {
        orderSubscriptionChange(id: $id, change: RESUME) { subscription { id } userErrors { message } } }`,
      { id: subscription.id },
    );
    expect(again.userErrors).toEqual([{ message: 'The subscription was cancelled' }]);
    const { rows: timeline } = await admin.query(
      `SELECT message FROM orders.order_events WHERE kind = 'subscription' ORDER BY id`,
    );
    expect(timeline.map((row) => row.message)).toEqual([
      expect.stringMatching(/^Subscribed: Every month, 10% off\. The next order is placed on /),
      expect.stringMatching(/^The customer skipped the subscription's order of /),
      'The customer paused the subscription',
      expect.stringMatching(/^The customer resumed the subscription: its next order is placed on /),
      'The customer cancelled the subscription',
    ]);
  });

  it('cancels a subscription with its first order, and forgets it with its erased customer', async () => {
    const [plan] = await data(`{ sellingPlans { ${PLAN} } }`);
    const { rows } = await admin.query<{ id: string }>(
      `SELECT v.id FROM catalog.variants v JOIN catalog.products p ON p.id = v.product_id
        WHERE p.title = 'Kashmiri chai'`,
    );
    const { id: order } = await checkout([
      { variantId: rows[0]!.id, quantity: 1, properties: { _selling_plan: plan.id } },
    ]);
    await hear('order.created', order);
    const active = (await data(SUBSCRIPTIONS)).find(
      (each: Json) => each.originOrderId === toPublicId('order', order),
    );
    expect(active.status).toBe('ACTIVE');
    await hear('order.cancelled', order);
    const gone = (await data(SUBSCRIPTIONS)).find((each: Json) => each.id === active.id);
    expect(gone.status).toBe('CANCELLED');

    // A subscription that keeps going still names its customer: erased, it goes.
    await admin.query(`UPDATE orders.subscriptions SET status = 'active'`);
    const { rows: customers } = await admin.query<{ customer_id: string }>(
      'SELECT DISTINCT customer_id FROM orders.subscriptions',
    );
    expect(customers.length).toBe(1);
    // As the customers module erases them, through the orders module's part (ADR-110).
    await worker.tenant(shop, (tx) =>
      ORDER_CUSTOMER_DATA.erase!(
        tx,
        shop,
        { id: customers[0]!.customer_id, phones: ['+923001234567'], email: null },
        'system',
      ),
    );
    expect((await admin.query('SELECT 1 FROM orders.subscriptions')).rows).toEqual([]);
  });
});
