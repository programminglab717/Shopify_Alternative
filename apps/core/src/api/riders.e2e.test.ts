import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe.skipIf(!server)(
  'Admin GraphQL API and pages: own riders (SHP-10, ADR-824, ADR-825)',
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let api: TestApi;
    let app: NestFastifyApplication;
    const shop = newId();
    const tokens = { owner: '', reader: '' };
    // The site the riders' links name.
    const SITE = 'http://localhost:4000';

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
        headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
        payload: { query, variables },
      });
      return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
    }

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
      tokens.owner = await issueToken(['write_products', 'write_orders']);
      tokens.reader = await issueToken(['read_products']);
      api = await startTestApi(testDb);
      app = api.app;
    });

    afterAll(async () => {
      await api?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('adds a rider, hands them an order, and takes its delivery from their page', async () => {
      const created = await gql(
        tokens.owner,
        `mutation {
        productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,000" }] }) {
          product { variants { id } }
        }
      }`,
      );
      const variantId = created.data?.productCreate.product.variants[0].id;
      const placed = await gql(
        tokens.owner,
        `mutation ($variantId: ID!) {
        orderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                             address1: "House 12, Street 4", city: "Lahore" }
        }) { order { id } userErrors { code message } }
      }`,
        { variantId },
      );
      const orderId = placed.data?.orderCreate.order.id;
      await gql(
        tokens.owner,
        `mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { code } } }`,
        {
          id: orderId,
        },
      );

      const made = (
        await gql(
          tokens.owner,
          `mutation { riderCreate(input: { name: "Asif", phone: "0300 1112223" }) {
           rider { id name phone active out cashHeld { amount } } link userErrors { code }
         } }`,
        )
      ).data?.riderCreate;
      expect(made).toEqual({
        rider: {
          id: expect.stringMatching(/^ridr_/),
          name: 'Asif',
          phone: '+923001112223',
          active: true,
          out: 0,
          cashHeld: { amount: '0.00' },
        },
        link: expect.stringMatching(new RegExp(`^${SITE}/rider/[A-Za-z0-9_-]{22}$`)),
        userErrors: [],
      });
      const handed = (
        await gql(
          tokens.owner,
          `mutation ($rider: ID!, $orders: [ID!]!) {
          riderHandOut(riderId: $rider, orderIds: $orders) {
            results { orderId problem delivery { id status cashDue { amount } codeSent } }
            userErrors { code }
          }
        }`,
          { rider: made.rider.id, orders: [orderId] },
        )
      ).data?.riderHandOut;
      expect(handed.results).toEqual([
        {
          orderId,
          problem: null,
          delivery: {
            id: expect.stringMatching(/^rdel_/),
            status: 'OUT',
            cashDue: { amount: '2000.00' },
            codeSent: true,
          },
        },
      ]);
      // Those who read no orders see no riders.
      expect((await gql(tokens.reader, '{ riders { id } }')).errors?.[0]?.extensions?.code).toBe(
        'ACCESS_DENIED',
      );

      // The rider's page, private and plain.
      const path = new URL(made.link).pathname;
      const page = await app.inject({ method: 'GET', url: path });
      expect([
        page.statusCode,
        page.headers['cache-control'],
        page.headers['referrer-policy'],
      ]).toEqual([200, 'no-store', 'no-referrer']);
      expect(page.body).toContain('Collect Rs 2,000');
      const action = /<form method="post" action="([^"]+\/delivered)">/.exec(page.body)![1]!;
      // The customer lost the code: delivered without it, the cash collected.
      const posted = await app.inject({
        method: 'POST',
        url: action,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'code=&cash=2000',
      });
      expect([posted.statusCode, posted.headers.location]).toEqual([303, `${path}?done`]);
      const after = (
        await gql(
          tokens.owner,
          '{ riders { out cashHeld { amount } } riderDeliveries { status codeGiven } }',
        )
      ).data;
      expect(after).toEqual({
        riders: [{ out: 0, cashHeld: { amount: '2000.00' } }],
        riderDeliveries: [{ status: 'DELIVERED', codeGiven: false }],
      });

      // The cash handed over (ADR-826): at most what the rider holds.
      const HAND_OVER = `mutation ($rider: ID!, $amount: String!) {
      riderHandOver(riderId: $rider, input: { amount: $amount }) {
        handover { amount { amount } } rider { cashHeld { amount } } userErrors { code }
      }
    }`;
      expect(
        (await gql(tokens.owner, HAND_OVER, { rider: made.rider.id, amount: '2,500' })).data
          ?.riderHandOver.userErrors,
      ).toEqual([{ code: 'INVALID' }]);
      expect(
        (await gql(tokens.owner, HAND_OVER, { rider: made.rider.id, amount: '2000' })).data
          ?.riderHandOver,
      ).toEqual({
        handover: { amount: { amount: '2000.00' } },
        rider: { cashHeld: { amount: '0.00' } },
        userErrors: [],
      });
      expect(
        (await app.inject({ method: 'GET', url: `/rider/${'x'.repeat(22)}` })).statusCode,
      ).toBe(404);
    });
  },
);
