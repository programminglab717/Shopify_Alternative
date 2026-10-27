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

describe.skipIf(!server)('Admin GraphQL API: drops (INV-09, ADR-820)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { owner: '', reader: '' };

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

  it('schedules a drop on Pro, its draft on sale at its start, and deletes it', async () => {
    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Lawn 3-piece", status: DRAFT, variants: [{ price: "4,500" }] }) {
          product { id }
        }
      }`,
    );
    const product = created.data?.productCreate.product;
    const start = new Date(Date.now() + 86_400_000);
    const input = {
      name: 'Eid lawn',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 86_400_000).toISOString(),
      productIds: [product.id],
      perCustomerLimit: 2,
    };
    const CREATE = `
      mutation ($input: DropInput!) {
        dropCreate(input: $input) {
          drop { id name status startsAt perCustomerLimit admitPerMinute products { id title status } }
          userErrors { field code message }
        }
      }`;
    // Free has no drops.
    expect((await gql(tokens.owner, CREATE, { input })).data?.dropCreate.userErrors).toEqual([
      {
        field: ['input'],
        code: 'PROHIBITED',
        message: "The Free plan doesn't include drops: choose the Pro plan to schedule one",
      },
    ]);
    await admin.query(
      `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
       VALUES ($1, 'pro', 'monthly', now(), now() + interval '1 month')`,
      [shop],
    );
    const made = (await gql(tokens.owner, CREATE, { input })).data?.dropCreate;
    expect(made).toEqual({
      drop: {
        id: expect.stringMatching(/^drop_/),
        name: 'Eid lawn',
        status: 'SCHEDULED',
        startsAt: start.toISOString(),
        perCustomerLimit: 2,
        admitPerMinute: null,
        products: [{ id: product.id, title: 'Lawn 3-piece', status: 'DRAFT' }],
      },
      userErrors: [],
    });
    const scheduled = await gql(
      tokens.owner,
      `query ($id: ID!) { product(id: $id) { publishAt } drops { id } }`,
      { id: product.id },
    );
    expect(scheduled.data).toEqual({
      product: { publishAt: start.toISOString() },
      drops: [{ id: made.drop.id }],
    });
    // Those who change no products change no drops.
    const denied = await gql(tokens.reader, CREATE, { input });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    const deleted = await gql(
      tokens.owner,
      `mutation ($id: ID!) { dropDelete(id: $id) { deletedId } }`,
      { id: made.drop.id },
    );
    expect(deleted.data?.dropDelete.deletedId).toBe(made.drop.id);
    expect(
      (
        await gql(tokens.owner, `query ($id: ID!) { product(id: $id) { publishAt } }`, {
          id: product.id,
        })
      ).data?.product.publishAt,
    ).toBeNull();
  });
});
