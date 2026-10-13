import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const REVIEW = 'id productId productTitle orderId authorName rating body status publishedAt';

describe.skipIf(!server)("Admin GraphQL API: products' reviews (MKT-05, ADR-399)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { all: '', orders: '' };
  let kurta = '';
  let product = '';

  async function issueToken(scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, hash, hint, scopes],
    );
    return token;
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    return response.json<{ data?: Json; errors?: Json[] }>();
  }

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    tokens.all = await issueToken([
      'write_products',
      'write_inventory',
      'write_locations',
      'write_orders',
      'write_settings',
    ]);
    tokens.orders = await issueToken(['write_orders']);
    api = await startTestApi(testDb);
    app = api.app;

    const created = await data(
      tokens.all,
      `mutation {
        productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,000" }] }) {
          product { id variants { id inventoryItem { id } } }
        }
      }`,
    );
    product = created.product.id;
    kurta = created.product.variants[0].id;
    const location = (await gql(tokens.all, '{ location { id } }')).data.location.id;
    await data(
      tokens.all,
      `mutation ($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { code } }
      }`,
      {
        input: {
          name: 'available',
          reason: 'received',
          quantities: [
            {
              inventoryItemId: created.product.variants[0].inventoryItem.id,
              locationId: location,
              quantity: 10,
            },
          ],
        },
      },
    );
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("takes a customer's stars on their delivered order's page, for the shop to publish or hide", async () => {
    const placed = await data(
      tokens.all,
      `mutation ($input: OrderCreateInput!) {
        orderCreate(input: $input) { order { id } userErrors { code } }
      }`,
      {
        input: {
          lineItems: [{ variantId: kurta, quantity: 1 }],
          shippingAddress: {
            name: 'Ayesha Khan',
            phone: '0300-1234567',
            address1: 'House 12, Street 4, Block 5',
            city: 'khi',
          },
        },
      },
    );
    const orderId = placed.order.id;
    const link = await data(
      tokens.all,
      'mutation ($id: ID!) { orderLinkCreate(id: $id) { url userErrors { code } } }',
      { id: orderId },
    );
    const path = new URL(link.url).pathname;
    const productUuid = fromPublicId(product, 'product');
    const rate = (form: string) =>
      app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form,
      });

    // Before it is delivered, there is nothing to rate.
    expect((await rate(`action=review&rating_${productUuid}=5`)).statusCode).toBe(409);
    await data(tokens.all, 'mutation ($id: ID!) { orderConfirm(id: $id) { order { id } } }', {
      id: orderId,
    });
    const parcel = await data(
      tokens.all,
      'mutation ($id: ID!) { orderFulfill(id: $id) { fulfillment { id } } }',
      { id: orderId },
    );
    await data(
      tokens.all,
      'mutation ($id: ID!) { fulfillmentMarkDelivered(id: $id) { fulfillment { id } } }',
      { id: parcel.fulfillment.id },
    );
    const page = await app.inject({ method: 'GET', url: path });
    expect(page.body).toContain(`name="rating_${productUuid}"`);

    const sent = await rate(
      `action=review&rating_${productUuid}=4&body_${productUuid}=${encodeURIComponent('Good stitching')}`,
    );
    expect(sent.statusCode).toBe(303);
    expect(sent.headers.location).toMatch(/\?reviewed$/);
    const thanked = await app.inject({ method: 'GET', url: `${path}?reviewed` });
    expect(thanked.body).toContain('Thank you for your rating!');

    const [waiting] = await data(
      tokens.all,
      '{ productReviews(status: PENDING) { ' + REVIEW + ' } }',
    );
    expect(waiting).toMatchObject({
      productId: product,
      productTitle: 'Kurta',
      orderId,
      authorName: 'Ayesha K.',
      rating: 4,
      body: 'Good stitching',
      status: 'PENDING',
      publishedAt: null,
    });
    expect(waiting.id).toMatch(/^rvw_/);

    const published = await data(
      tokens.all,
      `mutation ($id: ID!) {
        productReviewPublish(id: $id) { productReview { status publishedAt } userErrors { code } }
      }`,
      { id: waiting.id },
    );
    expect(published.productReview.status).toBe('PUBLISHED');
    const hidden = await data(
      tokens.all,
      `mutation ($id: ID!) {
        productReviewHide(id: $id) { productReview { status } userErrors { code } }
      }`,
      { id: waiting.id },
    );
    expect(hidden.productReview.status).toBe('HIDDEN');
    expect(
      (
        await data(
          tokens.all,
          'mutation { productReviewHide(id: "rvw_nope") { productReview { id } userErrors { field code } } }',
        )
      ).userErrors,
    ).toEqual([{ field: ['id'], code: 'NOT_FOUND' }]);

    // Reading and moderating them is for those who may read and change products.
    const denied = await gql(tokens.orders, '{ productReviews { id } }');
    expect(denied.errors?.[0].extensions.code).toBe('ACCESS_DENIED');
  });

  it('publishes reviews of as many stars as the shop says by themselves, and asks for them', async () => {
    expect(await data(tokens.all, '{ reviewSettings { publishFrom requestAfterDays } }')).toEqual({
      publishFrom: null,
      requestAfterDays: null,
    });
    const set = await data(
      tokens.all,
      `mutation {
        reviewSettingsUpdate(input: { publishFrom: 4 }) {
          reviewSettings { publishFrom requestAfterDays } userErrors { code }
        }
      }`,
    );
    expect(set).toEqual({
      reviewSettings: { publishFrom: 4, requestAfterDays: null },
      userErrors: [],
    });
    // And customers asked for them a week after delivery (ADR-400); the stars stay as they were.
    const asking = await data(
      tokens.all,
      `mutation {
        reviewSettingsUpdate(input: { requestAfterDays: 7 }) {
          reviewSettings { publishFrom requestAfterDays } userErrors { code }
        }
      }`,
    );
    expect(asking.reviewSettings).toEqual({ publishFrom: 4, requestAfterDays: 7 });
    const refused = await data(
      tokens.all,
      `mutation {
        reviewSettingsUpdate(input: { publishFrom: 1, requestAfterDays: 20 }) {
          reviewSettings { publishFrom } userErrors { field code }
        }
      }`,
    );
    expect(refused.userErrors).toEqual([
      { field: ['publishFrom'], code: 'INVALID' },
      { field: ['requestAfterDays'], code: 'INVALID' },
    ]);
    const { rows } = await admin.query(
      `SELECT event_type FROM platform.activity_log WHERE shop_id = $1 AND event_type LIKE 'review%'`,
      [shop],
    );
    expect(rows).toEqual([
      { event_type: 'review_settings.updated' },
      { event_type: 'review_settings.updated' },
    ]);
  });
});
