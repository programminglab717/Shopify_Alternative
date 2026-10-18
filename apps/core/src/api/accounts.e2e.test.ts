import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { sha256 } from '@hatti/crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { StorefrontApiClient, StorefrontApiError, accountPath } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Storefront API: shoppers' accounts, signed in to by a code", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  let client: StorefrontApiClient;
  const shop = newId();
  const other = newId();
  let token = '';

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

  /** The codes to sign in with sent so far, the newest last. */
  const codes = async () =>
    (
      await admin.query<{ shop_id: string; recipient: string; language: string; code: string }>(
        `SELECT shop_id, recipient, language, variables ->> 'code' AS code
           FROM messaging.messages WHERE kind = 'account_code' ORDER BY created_at, id`,
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'Other')`, [
      shop,
      other,
    ]);
    const generated = generateAccessToken();
    token = generated.token;
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, generated.hash, generated.hint, ['write_products', 'write_orders']],
    );
    api = await startTestApi(testDb);
    app = api.app;
    await app.listen(0, '127.0.0.1');
    client = new StorefrontApiClient({ baseUrl: await app.getUrl(), key: TEST_STOREFRONT_KEY });
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('signs a shopper in with a code, for storefronts with the key alone (ADR-570)', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: accountPath(shop, 'login'),
          payload: { phone: '0300 1234567' },
        })
      ).statusCode,
    ).toBe(401);

    expect(
      await client.accountLoginStart(
        shop,
        { phone: '0300-1234567', locale: 'ur' },
        { ip: '203.0.113.7' },
      ),
    ).toEqual({ ok: true, state: 'sent', phone: '0300 ••••567', channel: 'whatsapp' });
    expect(await client.accountLoginStart(shop, { phone: '042 1234567' })).toEqual({
      ok: false,
      errors: [
        { field: 'phone', message: 'Phone must be a Pakistani mobile number, like 0300 1234567' },
      ],
    });
    const [sent] = await codes();
    expect(sent).toMatchObject({ shop_id: shop, recipient: '+923001234567', language: 'ur' });
    const wrong = String((Number(sent!.code) + 1) % 10 ** 6).padStart(6, '0');
    expect(await client.accountLoginVerify(shop, { phone: '0300 1234567', code: wrong })).toEqual({
      ok: false,
      error: 'wrong',
    });
    const verified = await client.accountLoginVerify(shop, {
      phone: '0300 1234567',
      code: sent!.code,
    });
    if (!verified.ok) throw new Error(`Expected signed in, got ${verified.error}`);
    expect(verified.token).toMatch(/^[\w-]{43}$/);
    expect(verified.session).toMatchObject({ phone: '+923001234567', name: null });
    // The code signs in once; the token is kept as its digest alone.
    expect(
      await client.accountLoginVerify(shop, { phone: '0300 1234567', code: sent!.code }),
    ).toEqual({ ok: false, error: 'expired' });
    const { rows } = await admin.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM checkout.account_sessions',
    );
    expect(rows).toEqual([{ token_hash: sha256(verified.token) }]);
    expect(await client.accountSession(shop, verified.token)).toEqual(verified.session);
    // Not another shop's.
    expect(await client.accountSession(other, verified.token)).toBeNull();
    expect(await client.account(other, verified.token)).toBeNull();
    // Not a shop's ID: nothing there.
    await expect(client.account('not-a-shop', verified.token)).rejects.toThrow(StorefrontApiError);
  });

  it("reads the shopper's orders, opens their pages, and signs out", async () => {
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
              lineItems: [{ variantId: $variantId, quantity: 3 }]
              shippingAddress: {
                name: "Ayesha Khan"
                phone: "0300 1234567"
                address1: "House 12, Street 4"
                city: "Lahore"
              }
            }
          ) {
            order {
              id
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
    const order = placed.orderCreate.order as { id: string; name: string };

    await client.accountLoginStart(shop, { phone: '0300 1234567' });
    const verified = await client.accountLoginVerify(shop, {
      phone: '0300 1234567',
      code: (await codes()).at(-1)!.code,
    });
    if (!verified.ok) throw new Error(`Expected signed in, got ${verified.error}`);
    const account = await client.account(shop, verified.token);
    expect(account).toMatchObject({
      phone: '+923001234567',
      name: 'Ayesha Khan',
      orders: [
        {
          id: order.id,
          name: order.name,
          status: 'open',
          financialStatus: 'pending',
          fulfillmentStatus: 'unfulfilled',
          currency: 'PKR',
          itemCount: 3,
          hasPage: true,
        },
      ],
      storeCredit: { balance: 0, currency: 'PKR', expiring: null },
    });

    // Its page, through its link on the core's address, which shows it.
    const link = await client.accountOrderLink(shop, verified.token, order.id);
    expect(link).toEqual({
      path: expect.stringMatching(/^\/o\/[\w-]{22}$/),
      url: expect.any(String),
    });
    const page = await app.inject({ method: 'GET', url: link!.path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(order.name);
    expect(await client.accountOrderLink(shop, verified.token, 'ord_nothing')).toBeNull();
    expect(await client.accountOrderLink(shop, 'x'.repeat(43), order.id)).toBeNull();

    await client.accountLogout(shop, verified.token);
    expect(await client.account(shop, verified.token)).toBeNull();
    expect(await client.accountSession(shop, verified.token)).toBeNull();
    expect(await client.accountOrderLink(shop, verified.token, order.id)).toBeNull();
  });
});
