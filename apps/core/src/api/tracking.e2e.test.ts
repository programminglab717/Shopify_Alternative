import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { trackingPath, type TrackingPageResponse } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

describe.skipIf(!server)("The shop's tracking page", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  let token = '';

  const asStorefront = { authorization: `Bearer ${TEST_STOREFRONT_KEY}` };

  async function graphql(query: string, variables: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    const body = response.json();
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return body.data;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    const generated = generateAccessToken();
    token = generated.token;
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, generated.hash, generated.hint, ['write_products', 'write_orders']],
    );
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('finds an order by its number and mobile number, for storefronts alone (ADR-251)', async () => {
    const created = await graphql(`
      mutation {
        productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,000" }] }) {
          product {
            variants {
              id
            }
          }
        }
      }
    `);
    const placed = await graphql(
      `
        mutation ($variantId: ID!) {
          orderCreate(
            input: {
              lineItems: [{ variantId: $variantId, quantity: 1 }]
              shippingAddress: {
                name: "Ayesha Khan"
                phone: "0300 1234567"
                address1: "House 12, Street 4"
                city: "Lahore"
              }
            }
          ) {
            order {
              name
            }
            userErrors {
              message
            }
          }
        }
      `,
      { variantId: created.productCreate.product.variants[0].id },
    );
    const name = placed.orderCreate.order.name as string;

    const form = await app.inject({
      method: 'GET',
      url: trackingPath(shop),
      headers: asStorefront,
    });
    expect(form.statusCode).toBe(200);
    expect((form.json() as TrackingPageResponse).html).toContain('Track your order');

    const ask = (body: Record<string, string>) =>
      app.inject({ method: 'POST', url: trackingPath(shop), headers: asStorefront, payload: body });
    const found = (await ask({ reference: name, phone: '0300-1234567' })).json();
    expect(found.status).toBe(200);
    expect(found.html).toContain(`Your order ${name}`);
    expect(found.headers['x-robots-tag']).toBe('noindex, nofollow');
    const wrong = (await ask({ reference: name, phone: '0321-7654321' })).json();
    expect(wrong.status).toBe(404);
    expect(wrong.html).not.toContain(`Your order ${name}`);

    const unsigned = await app.inject({ method: 'GET', url: trackingPath(shop) });
    expect(unsigned.statusCode).toBe(401);
  });
});
