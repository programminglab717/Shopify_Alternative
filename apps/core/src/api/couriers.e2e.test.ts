import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const TOKEN = 'pX7tokenLive0042abcd';

const ACCOUNT = 'id courier courierName name credentialsHint pickupCode isDefault archivedAt';

const CONNECT = `mutation ($input: CourierAccountInput!) {
  courierAccountConnect(input: $input) {
    courierAccount { ${ACCOUNT} }
    userErrors { field code message }
  }
}`;

const BOOK = `mutation ($ids: [ID!]!, $accountId: ID) {
  ordersBook(ids: $ids, accountId: $accountId) {
    bookings {
      id orderId orderName accountId courierName status attempts error trackingNumber
      codAmount { amount } fulfillmentId courierStatus parcelStatus bookedAt createdAt
    }
    refused { orderId message }
    userErrors { field code message }
  }
}`;

const BOOKINGS = `query ($first: Int, $after: String, $status: CourierBookingStatus, $orderId: ID) {
  courierBookings(first: $first, after: $after, status: $status, orderId: $orderId) {
    nodes { id orderName status }
    pageInfo { hasNextPage endCursor }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: couriers and bookings', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { settings: '', orders: '', reader: '', catalog: '' };

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

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  /** An order of a shawl to Lahore; confirmed unless asked otherwise. */
  async function order(variantId: string, confirm = true): Promise<string> {
    const placed = await data(
      tokens.orders,
      `mutation ($variantId: ID!) {
        orderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                             address1: "House 12, Street 4", city: "Lahore" }
        }) { order { id } userErrors { code message } }
      }`,
      { variantId },
    );
    const id = placed.order.id as string;
    if (confirm) {
      await data(
        tokens.orders,
        `mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { code } } }`,
        {
          id,
        },
      );
    }
    return id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.settings = await issueToken(['write_settings', 'read_orders']);
    tokens.orders = await issueToken(['write_products', 'write_orders']);
    tokens.reader = await issueToken(['read_orders']);
    tokens.catalog = await issueToken(['read_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("lists couriers, and connects the shop's accounts without ever showing their credentials", async () => {
    expect(
      await data(
        tokens.reader,
        '{ couriers { courier name credentials { key label } pickupCode test } }',
      ),
    ).toEqual([
      {
        courier: 'postex',
        name: 'PostEx',
        credentials: [{ key: 'token', label: 'API token' }],
        pickupCode: 'Pickup address code',
        test: false,
      },
      {
        courier: 'test',
        name: 'Test courier',
        credentials: [{ key: 'key', label: 'Any key' }],
        pickupCode: null,
        test: true,
      },
    ]);
    expect(
      (await gql(tokens.catalog, '{ couriers { courier } }')).errors?.[0].extensions.code,
    ).toBe('ACCESS_DENIED');

    const input = {
      courier: 'postex',
      name: 'PostEx Lahore',
      credentials: [{ key: 'token', value: TOKEN }],
      pickupCode: 'LHR-0042',
    };
    // Accounts are settings: orders' apps and staff connect none.
    expect((await gql(tokens.orders, CONNECT, { input })).errors?.[0].extensions.code).toBe(
      'ACCESS_DENIED',
    );
    const connected = await gql(tokens.settings, CONNECT, { input });
    expect(JSON.stringify(connected)).not.toContain(TOKEN);
    const account = connected.data?.courierAccountConnect.courierAccount;
    expect(account).toMatchObject({
      courier: 'postex',
      courierName: 'PostEx',
      name: 'PostEx Lahore',
      credentialsHint: 'abcd',
      pickupCode: 'LHR-0042',
      isDefault: true,
      archivedAt: null,
    });
    expect(account.id).toMatch(/^cra_/);
    expect(
      (
        await data(tokens.settings, CONNECT, {
          input: { courier: 'postex', credentials: [] },
        })
      ).userErrors,
    ).toEqual([
      { field: ['input', 'credentials'], code: 'BLANK', message: 'PostEx needs its API token' },
    ]);

    const renamed = await data(
      tokens.settings,
      `mutation ($id: ID!) {
        courierAccountUpdate(id: $id, input: { name: "PostEx Main" }) {
          courierAccount { name } userErrors { field code }
        }
      }`,
      { id: account.id },
    );
    expect(renamed).toEqual({ courierAccount: { name: 'PostEx Main' }, userErrors: [] });
    expect(await data(tokens.reader, `{ courierAccounts { ${ACCOUNT} } }`)).toEqual([
      { ...account, name: 'PostEx Main' },
    ]);

    const archived = await data(
      tokens.settings,
      `mutation ($id: ID!) {
        courierAccountArchive(id: $id) { courierAccount { isDefault archivedAt } userErrors { code } }
      }`,
      { id: account.id },
    );
    expect(archived.courierAccount.isDefault).toBe(false);
    expect(archived.courierAccount.archivedAt).toEqual(expect.any(String));
    expect(await data(tokens.reader, '{ courierAccounts { id } }')).toEqual([]);
    expect(await data(tokens.reader, '{ courierAccounts(archived: true) { id } }')).toEqual([
      { id: account.id },
    ]);
  });

  it('books orders, refusing those that cannot ship, and cancels bookings while they wait', async () => {
    const test = await data(tokens.settings, CONNECT, {
      input: { courier: 'test', credentials: [{ key: 'key', value: 'anything-1234' }] },
    });
    expect(test.courierAccount.isDefault).toBe(true);
    const created = await data(
      tokens.orders,
      `mutation {
        productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "5,000" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const variantId = created.product.variants[0].id as string;
    const [confirmed, waiting, other] = [
      await order(variantId),
      await order(variantId, false),
      await order(variantId),
    ];

    expect((await gql(tokens.reader, BOOK, { ids: [confirmed] })).errors?.[0].extensions.code).toBe(
      'ACCESS_DENIED',
    );
    expect(
      (await gql(tokens.orders, BOOK, { ids: ['nonsense'] })).errors?.[0].extensions.code,
    ).toBe('BAD_USER_INPUT');
    const booked = await data(tokens.orders, BOOK, { ids: [confirmed, waiting] });
    expect(booked.userErrors).toEqual([]);
    expect(booked.bookings).toEqual([
      {
        id: expect.stringMatching(/^bkg_/),
        orderId: confirmed,
        orderName: '#1001',
        accountId: test.courierAccount.id,
        courierName: 'Test courier',
        status: 'PENDING',
        attempts: 0,
        error: null,
        trackingNumber: null,
        codAmount: null,
        fulfillmentId: null,
        courierStatus: null,
        parcelStatus: null,
        bookedAt: null,
        createdAt: expect.any(String),
      },
    ]);
    expect(booked.refused).toEqual([
      { orderId: waiting, message: 'Confirm the order with the customer before shipping it' },
    ]);
    const unknown = toPublicId('courierAccount', newId());
    expect(
      (await data(tokens.orders, BOOK, { ids: [other], accountId: unknown })).userErrors,
    ).toEqual([{ field: ['accountId'], code: 'NOT_FOUND', message: 'Courier account not found' }]);
    const second = await data(tokens.orders, BOOK, { ids: [other] });

    const first = await data(tokens.reader, BOOKINGS, { first: 1 });
    expect(first.nodes).toEqual([
      { id: second.bookings[0].id, orderName: '#1003', status: 'PENDING' },
    ]);
    expect(first.pageInfo.hasNextPage).toBe(true);
    const next = await data(tokens.reader, BOOKINGS, { first: 1, after: first.pageInfo.endCursor });
    expect(next.nodes).toEqual([
      { id: booked.bookings[0].id, orderName: '#1001', status: 'PENDING' },
    ]);
    expect(next.pageInfo.hasNextPage).toBe(false);
    expect((await data(tokens.reader, BOOKINGS, { orderId: confirmed })).nodes).toHaveLength(1);

    const CANCEL = `mutation ($id: ID!) {
      courierBookingCancel(id: $id) { courierBooking { status } userErrors { field code message } }
    }`;
    expect(await data(tokens.orders, CANCEL, { id: booked.bookings[0].id })).toEqual({
      courierBooking: { status: 'CANCELLED' },
      userErrors: [],
    });
    expect((await data(tokens.orders, CANCEL, { id: booked.bookings[0].id })).userErrors).toEqual([
      {
        field: ['id'],
        code: 'INVALID',
        message: 'Only a booking waiting can be cancelled: this one is cancelled',
      },
    ]);
    expect((await data(tokens.reader, BOOKINGS, { status: 'CANCELLED' })).nodes).toEqual([
      { id: booked.bookings[0].id, orderName: '#1001', status: 'CANCELLED' },
    ]);
    expect(
      await data(
        tokens.reader,
        `query ($id: ID!) { courierBooking(id: $id) { orderName status } }`,
        {
          id: second.bookings[0].id,
        },
      ),
    ).toEqual({ orderName: '#1003', status: 'PENDING' });
  });
});
