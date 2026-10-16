import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SALE = `
  id name percentOff status startsAt endsAt endedAt productsCount products { title }
`;
const CREATE = `mutation ($input: PriceSaleCreateInput!) {
  priceSaleCreate(input: $input) { priceSale { ${SALE} } userErrors { field code } }
}`;
const CANCEL = `mutation ($id: ID!) {
  priceSaleCancel(id: $id) { priceSale { ${SALE} } userErrors { field code } }
}`;
const PRICE = `query ($id: ID!) {
  product(id: $id) { variants { price { amount } compareAtPrice { amount } } }
}`;
const DAY = 86_400_000;

describe.skipIf(!server)('Admin GraphQL API: sales set ahead (CAT-17, ADR-443)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { write: '', read: '', orders: '' };

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

  async function product(title: string): Promise<string> {
    const created = await data(
      tokens.write,
      `mutation ($input: ProductCreateInput!) {
        productCreate(input: $input) { product { id } }
      }`,
      { input: { title, status: 'ACTIVE', variants: [{ price: '4,999' }] } },
    );
    return created.product.id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    tokens.write = await issueToken(['write_products']);
    tokens.read = await issueToken(['read_products']);
    tokens.orders = await issueToken(['read_orders']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  async function price(id: string) {
    return (await data(tokens.read, PRICE, { id })).variants[0];
  }

  it('sets a sale ahead, starts one now with its prices cut, and ends it early', async () => {
    const lawn = await product('Lawn suit');
    const later = new Date(Date.now() + DAY).toISOString();
    const end = new Date(Date.now() + 3 * DAY).toISOString();
    const ahead = await data(tokens.write, CREATE, {
      input: { name: 'Eid sale', percentOff: 25, startsAt: later, endsAt: end, productIds: [lawn] },
    });
    expect(ahead).toEqual({
      priceSale: expect.objectContaining({
        name: 'Eid sale',
        percentOff: 25,
        status: 'SCHEDULED',
        startsAt: later,
        endedAt: null,
        productsCount: 1,
        products: [{ title: 'Lawn suit' }],
      }),
      userErrors: [],
    });
    const cancelled = await data(tokens.write, CANCEL, { id: ahead.priceSale.id });
    expect(cancelled.priceSale.status).toBe('CANCELLED');

    expect(await price(lawn)).toEqual({ price: { amount: '4999.00' }, compareAtPrice: null });
    const now = await data(tokens.write, CREATE, {
      input: {
        name: 'Flash sale',
        percentOff: 50,
        startsAt: new Date().toISOString(),
        endsAt: end,
        productIds: [lawn],
      },
    });
    expect(now.priceSale.status).toBe('RUNNING');
    expect(await price(lawn)).toEqual({
      price: { amount: '2499.00' },
      compareAtPrice: { amount: '4999.00' },
    });
    const ended = await data(tokens.write, CANCEL, { id: now.priceSale.id });
    expect(ended.priceSale.status).toBe('ENDED');
    expect(ended.priceSale.endedAt).not.toBeNull();
    expect(await price(lawn)).toEqual({ price: { amount: '4999.00' }, compareAtPrice: null });
    expect(await data(tokens.read, `query { priceSales { name status } }`)).toEqual([
      { name: 'Eid sale', status: 'CANCELLED' },
      { name: 'Flash sale', status: 'ENDED' },
    ]);
  });

  it('says what is wrong, and asks the scopes products need', async () => {
    const kurta = await product('Kurta');
    const later = new Date(Date.now() + DAY).toISOString();
    const input = {
      name: 'Sale',
      percentOff: 95,
      startsAt: later,
      endsAt: later,
      productIds: [kurta],
    };
    expect(await data(tokens.write, CREATE, { input })).toEqual({
      priceSale: null,
      userErrors: [
        { field: ['percentOff'], code: 'INVALID' },
        { field: ['endsAt'], code: 'INVALID' },
      ],
    });
    const unknown = {
      ...input,
      percentOff: 10,
      endsAt: new Date(Date.now() + 2 * DAY).toISOString(),
      productIds: ['prod_x'],
    };
    expect(await data(tokens.write, CREATE, { input: unknown })).toEqual({
      priceSale: null,
      userErrors: [{ field: ['productIds', '0'], code: 'NOT_FOUND' }],
    });
    expect(await data(tokens.write, CANCEL, { id: 'sale_x' })).toEqual({
      priceSale: null,
      userErrors: [{ field: ['id'], code: 'NOT_FOUND' }],
    });
    const denied = await gql(tokens.read, CANCEL, { id: 'sale_x' });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const unread = await gql(tokens.orders, `query { priceSales { id } }`);
    expect(unread.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});
