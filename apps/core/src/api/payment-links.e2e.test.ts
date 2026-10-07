import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import { paymentLinkPath, type PaymentLinkOpenResponse } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

const LINK_FIELDS = `id title url items { variantId quantity title } discountCode prepaidOnly
  usageLimit ordersPlaced active open`;

describe.skipIf(!server)('Payment links', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  let token = '';
  let kurta = '';

  const asStorefront = { authorization: `Bearer ${TEST_STOREFRONT_KEY}` };

  async function graphql(query: string, variables: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: { query, variables },
    });
    const body = response.json();
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return body.data;
  }

  async function open(shopId: string, linkToken: string, headers = asStorefront) {
    return app.inject({
      method: 'POST',
      url: paymentLinkPath(shopId, linkToken),
      headers,
      payload: {},
    });
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'Other')`, [
      shopA,
      shopB,
    ]);
    const generated = generateAccessToken();
    token = generated.token;
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopA, generated.hash, generated.hint, ['write_products', 'write_orders']],
    );
    api = await startTestApi(testDb);
    app = api.app;
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
    kurta = created.productCreate.product.variants[0].id;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('makes a link through the Admin API that many customers order through, until it closes', async () => {
    const made = await graphql(
      `mutation ($input: PaymentLinkInput!) {
        paymentLinkCreate(input: $input) {
          paymentLink { ${LINK_FIELDS} }
          userErrors { field code message }
        }
      }`,
      { input: { title: 'Kurta on Instagram', items: [{ variantId: kurta, quantity: 2 }] } },
    );
    const link = made.paymentLinkCreate.paymentLink;
    expect(made.paymentLinkCreate.userErrors).toEqual([]);
    expect(link).toMatchObject({
      title: 'Kurta on Instagram',
      items: [{ variantId: kurta, quantity: 2, title: 'Kurta' }],
      discountCode: null,
      prepaidOnly: false,
      usageLimit: null,
      ordersPlaced: 0,
      active: true,
      open: true,
    });
    expect(fromPublicId(link.id, 'paymentLink')).toMatch(/^[0-9a-f-]{36}$/);
    const linkToken = /\/pay\/([\w-]{22})$/.exec(link.url)![1]!;

    // The storefront opens it: a checkout of the customer's own, with its items.
    const opened = await open(shopA, linkToken);
    expect(opened.statusCode).toBe(200);
    const { path } = opened.json() as { path: string };
    expect(path).toMatch(/^\/checkouts\/[\w-]{22}$/);
    const page = await app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Kurta');
    const shown = /name="shown" value="([\w-]{22})"/.exec(page.body)![1]!;
    const placed = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        shown,
        name: 'Ayesha Khan',
        phone: '0300 1234567',
        city: 'Lahore',
        address1: 'House 12, Street 4',
        address2: 'Gulberg III',
      }).toString(),
    });
    expect(placed.statusCode).toBe(303);
    const { rows } = await admin.query<{ source: string; total: string }>(
      'SELECT source, total::text FROM orders.orders WHERE shop_id = $1',
      [shopA],
    );
    expect(rows).toEqual([{ source: 'online_store', total: expect.any(String) }]);
    const read = await graphql(
      `
        query ($id: ID!) {
          paymentLink(id: $id) {
            ordersPlaced
          }
        }
      `,
      {
        id: link.id,
      },
    );
    expect(read.paymentLink.ordersPlaced).toBe(1);

    // Closed by staff: the page says so, and no other shop's storefront opens it.
    const closed = await graphql(
      `
        mutation ($id: ID!) {
          paymentLinkUpdate(id: $id, input: { active: false }) {
            paymentLink {
              active
              open
            }
            userErrors {
              field
            }
          }
        }
      `,
      { id: link.id },
    );
    expect(closed.paymentLinkUpdate.paymentLink).toEqual({ active: false, open: false });
    const refused = (await open(shopA, linkToken)).json() as PaymentLinkOpenResponse;
    expect(refused).toMatchObject({ status: 410 });
    expect('html' in refused && refused.html).toContain('This link no longer takes orders');
    expect(((await open(shopB, linkToken)).json() as { status: number }).status).toBe(404);
    expect((await open(shopA, linkToken, {} as typeof asStorefront)).statusCode).toBe(401);
    const listed = await graphql(`
      {
        paymentLinks {
          id
          title
        }
      }
    `);
    expect(listed.paymentLinks).toEqual([{ id: link.id, title: 'Kurta on Instagram' }]);
  });

  it('refuses what is not a variant of the shop, saying where', async () => {
    const made = await graphql(
      `
        mutation ($input: PaymentLinkInput!) {
          paymentLinkCreate(input: $input) {
            paymentLink {
              id
            }
            userErrors {
              field
              code
            }
          }
        }
      `,
      { input: { title: 'Nothing', items: [] } },
    );
    expect(made.paymentLinkCreate).toEqual({
      paymentLink: null,
      userErrors: [{ field: ['input', 'items'], code: 'BLANK' }],
    });
  });
});
