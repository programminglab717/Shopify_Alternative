import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { sha256 } from '@hatti/crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import {
  StorefrontApiClient,
  StorefrontApiError,
  accountPath,
  accountWishlistItemPath,
} from '@hatti/storefront-api';
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
          lines: [
            {
              variantId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
              productTitle: 'Kurta',
              variantTitle: null,
              quantity: 3,
              available: true,
            },
          ],
        },
      ],
      storeCredit: { balance: 0, currency: 'PKR', expiring: null, history: [] },
    });
    // Bought again (ADR-574): its variant as the cart names it, which the cart takes.
    const [line] = account!.orders[0]!.lines;
    const again = await client.act(shop, null, 'add', {
      items: [{ variantId: line!.variantId!, quantity: line!.quantity }],
    });
    expect(again).toMatchObject({ ok: true, cart: { itemCount: 3, items: [{ title: 'Kurta' }] } });

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

  it("gives the shopper their own data, and files their erasure for the shop's staff to see (ADR-572)", async () => {
    // Without a session, nothing; with the storefront's key alone, nothing either.
    for (const route of ['data/export', 'data/erase'] as const) {
      expect((await app.inject({ method: 'POST', url: accountPath(shop, route) })).statusCode).toBe(
        401,
      );
    }
    expect(await client.accountDataExport(shop, 'x'.repeat(43))).toBeNull();
    expect(await client.accountDataErase(shop, 'x'.repeat(43))).toBeNull();

    // The customer of the order placed before.
    await client.accountLoginStart(shop, { phone: '0300 1234567' });
    const verified = await client.accountLoginVerify(shop, {
      phone: '0300 1234567',
      code: (await codes()).at(-1)!.code,
    });
    if (!verified.ok) throw new Error(`Expected signed in, got ${verified.error}`);
    const session = verified.token;
    expect((await client.account(shop, session))!.dataRequests).toEqual({
      available: true,
      erasureWaitDays: 10,
      export: null,
      erasure: null,
    });
    expect(await client.accountDataExportLink(shop, session)).toBeNull();

    // Their file, made once and kept for the day, downloaded from storage through its link.
    const file = (await client.accountDataExport(shop, session))!;
    if (file.state !== 'ready') throw new Error(`Expected a file, got ${file.state}`);
    expect(file).toMatchObject({ state: 'ready', made: true });
    const url = new URL(file.url);
    expect(url.pathname).toMatch(
      new RegExp(`^/storage/shops/${shop}/customer-data/[0-9a-f-]{36}\\.json$`),
    );
    const downloaded = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.json()).toMatchObject({
      format: 'hatti.customer-data/1',
      customer: { name: 'Ayesha Khan', phone: '+923001234567' },
      orders: [expect.objectContaining({ phone: '+923001234567' })],
    });
    const again = (await client.accountDataExport(shop, session))!;
    expect(again).toMatchObject({ made: false, readyAt: file.readyAt });
    expect(await client.accountDataExportLink(shop, session)).toMatchObject({
      made: false,
      readyAt: file.readyAt,
    });
    expect((await client.account(shop, session))!.dataRequests.export).toEqual({
      state: 'ready',
      readyAt: file.readyAt,
      expiresAt: file.expiresAt,
    });

    // Their erasure, held by their open order; asked again, the same.
    const erasure = (await client.accountDataErase(shop, session))!;
    expect(erasure).toMatchObject({ state: 'held' });
    expect(await client.accountDataErase(shop, session)).toEqual(erasure);

    // The shop's staff see it among the erasures waiting, asked for by the customer, and the
    // audit log names the customer as who asked for both.
    await admin.query(`UPDATE apps.access_tokens SET scopes = $2 WHERE shop_id = $1`, [
      shop,
      ['write_products', 'write_orders', 'read_customers', 'read_settings'],
    ]);
    const data = await graphql(`
      {
        customerErasureRequests(first: 5) {
          nodes {
            requestedBy
            customer {
              id
            }
          }
        }
        auditLog(first: 5) {
          nodes {
            action
            subjectId
            actor {
              kind
              id
              role
            }
          }
        }
      }
    `);
    const [waiting] = data.customerErasureRequests.nodes as {
      requestedBy: string;
      customer: { id: string };
    }[];
    expect(waiting!.requestedBy).toBe('CUSTOMER');
    const customerId = waiting!.customer.id;
    const actor = { kind: 'CUSTOMER', id: customerId, role: null };
    expect(data.auditLog.nodes).toEqual([
      { action: 'customer.erasure_requested', subjectId: customerId, actor },
      { action: 'customer.data_exported', subjectId: customerId, actor },
    ]);
  });

  it("keeps the shopper's wishlist with their account, by the catalog's IDs (ADR-575)", async () => {
    // Without the storefront's key, nothing; without a session, nothing either.
    expect(
      (await app.inject({ method: 'GET', url: accountPath(shop, 'wishlist') })).statusCode,
    ).toBe(401);
    expect(await client.accountWishlist(shop, 'x'.repeat(43))).toBeNull();
    expect(await client.accountWishlistAdd(shop, 'x'.repeat(43), [])).toBeNull();

    const created = await graphql(`
      mutation {
        productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "3,000" }] }) {
          product {
            id
          }
        }
      }
    `);
    const { rows } = await admin.query<{ id: string; title: string }>(
      `SELECT id, title FROM catalog.products WHERE shop_id = $1 ORDER BY title`,
      [shop],
    );
    const [kurta, shawl] = rows.map((row) => row.id) as [string, string];
    expect(rows.map((row) => row.title)).toEqual(['Kurta', 'Shawl']);
    expect(created.productCreate.product.id).toMatch(/^prod_/);

    // The customer of the order placed before: kept as theirs.
    await client.accountLoginStart(shop, { phone: '0300 1234567' });
    const verified = await client.accountLoginVerify(shop, {
      phone: '0300 1234567',
      code: (await codes()).at(-1)!.code,
    });
    if (!verified.ok) throw new Error(`Expected signed in, got ${verified.error}`);
    const session = verified.token;
    expect(await client.accountWishlist(shop, session)).toEqual([]);
    // The newest first; IDs that name none of the shop's products left out.
    expect(
      await client.accountWishlistAdd(shop, session, [shawl, kurta, newId(), 'prod_nothing']),
    ).toEqual([shawl, kurta]);
    expect(await client.accountWishlist(shop, session)).toEqual([shawl, kurta]);
    expect(await client.accountWishlist(other, session)).toBeNull();
    const kept = await admin.query<{ customer_id: string | null; phone: string | null }>(
      'SELECT DISTINCT customer_id, phone FROM checkout.account_wishlist_items',
    );
    expect(kept.rows).toEqual([{ customer_id: expect.any(String) as unknown, phone: null }]);

    expect(await client.accountWishlistRemove(shop, session, shawl)).toEqual([kurta]);
    expect(await client.accountWishlistRemove(shop, session, 'prod_nothing')).toEqual([kurta]);

    // Answers are never kept; what is not a list of IDs, or too long, is refused.
    const headers = { authorization: `Bearer ${TEST_STOREFRONT_KEY}`, 'x-hatti-account': session };
    const read = await app.inject({ method: 'GET', url: accountPath(shop, 'wishlist'), headers });
    expect([read.statusCode, read.headers['cache-control'], read.json()]).toEqual([
      200,
      'no-store',
      { productIds: [kurta] },
    ]);
    for (const payload of [{ productIds: kurta }, { productIds: Array(101).fill(kurta) }, {}]) {
      const refused = await app.inject({
        method: 'POST',
        url: accountPath(shop, 'wishlist'),
        headers,
        payload,
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ errors: [{ field: 'productIds' }] });
    }
    const removed = await app.inject({
      method: 'DELETE',
      url: accountWishlistItemPath(shop, kurta),
      headers,
    });
    expect([removed.statusCode, removed.json()]).toEqual([200, { productIds: [] }]);

    // The products viewed, a list of their own (ADR-978): viewed again, one moves to the top.
    expect(await client.accountViewed(shop, session)).toEqual([]);
    expect(await client.accountViewedAdd(shop, session, [kurta, shawl])).toEqual([kurta, shawl]);
    expect(await client.accountViewedAdd(shop, session, [shawl])).toEqual([shawl, kurta]);
    expect(await client.accountWishlist(shop, session)).toEqual([]);
    const tooMany = await app.inject({
      method: 'POST',
      url: accountPath(shop, 'viewed'),
      headers,
      payload: { productIds: Array(21).fill(kurta) },
    });
    expect(tooMany.statusCode).toBe(422);

    // Signed out, nothing.
    await client.accountLogout(shop, session);
    expect(await client.accountWishlistAdd(shop, session, [kurta])).toBeNull();
    expect(await client.accountWishlistRemove(shop, session, kurta)).toBeNull();
    expect(await client.accountViewed(shop, session)).toBeNull();
  });

  it("keeps the shopper's address book with their account, checked as checkout's (ADR-583)", async () => {
    // Without the storefront's key, nothing; without a session, nothing either.
    expect(
      (await app.inject({ method: 'GET', url: accountPath(shop, 'addresses') })).statusCode,
    ).toBe(401);
    expect(await client.accountAddresses(shop, 'x'.repeat(43))).toBeNull();

    await client.accountLoginStart(shop, { phone: '0300 1234567' });
    const verified = await client.accountLoginVerify(shop, {
      phone: '0300 1234567',
      code: (await codes()).at(-1)!.code,
    });
    if (!verified.ok) throw new Error(`Expected signed in, got ${verified.error}`);
    const session = verified.token;
    expect(await client.accountAddresses(shop, session)).toEqual([]);
    const typed = {
      name: 'Ayesha Khan',
      phone: '0300 1234567',
      address1: 'House 12, Street 4',
      landmark: 'Near the mosque',
      city: 'karachi',
    };
    const saved = await client.accountAddressSave(shop, session, typed);
    if (!saved?.ok) throw new Error(`Expected saved, got ${JSON.stringify(saved)}`);
    const [home] = saved.addresses;
    expect(home).toEqual({
      id: expect.stringMatching(/^addr_/) as unknown,
      name: 'Ayesha Khan',
      phone: '+923001234567',
      address1: 'House 12, Street 4',
      address2: null,
      landmark: 'Near the mosque',
      city: 'Karachi',
      provinceCode: 'SD',
      province: 'Sindh',
      zip: null,
      default: true,
    });
    const office = await client.accountAddressSave(shop, session, {
      ...typed,
      address1: 'Office 3, Shahrah-e-Faisal',
      default: true,
    });
    expect(office?.ok && office.addresses.map((a) => [a.address1, a.default])).toEqual([
      ['Office 3, Shahrah-e-Faisal', true],
      ['House 12, Street 4', false],
    ]);
    // What will not do, said field by field.
    expect(
      await client.accountAddressSave(shop, session, { ...typed, city: '' }, home!.id),
    ).toEqual({ ok: false, errors: [{ field: 'city', message: "City can't be blank" }] });
    const headers = { authorization: `Bearer ${TEST_STOREFRONT_KEY}`, 'x-hatti-account': session };
    const refused = await app.inject({
      method: 'PUT',
      url: `${accountPath(shop, 'addresses')}/addr_nothing`,
      headers,
      payload: typed,
    });
    expect([refused.statusCode, refused.headers['cache-control'], refused.json()]).toEqual([
      422,
      'no-store',
      { errors: [{ field: 'id', message: 'Id is not one of your addresses' }] },
    ]);
    const blank = await app.inject({
      method: 'POST',
      url: accountPath(shop, 'addresses'),
      headers,
      payload: {},
    });
    expect(blank.json()).toMatchObject({
      errors: [{ field: 'name' }, { field: 'phone' }, { field: 'address1' }, { field: 'city' }],
    });
    // The shop's staff see the book on the customer, the default first (ADR-588).
    const customers = await graphql(`
      {
        customers(first: 10) {
          nodes {
            phone
            savedAddresses {
              address1
              city
              province
              phone
            }
            defaultAddress {
              address1
            }
          }
        }
      }
    `);
    expect(
      customers.customers.nodes.find((c: { phone: string }) => c.phone === '+923001234567'),
    ).toEqual({
      phone: '+923001234567',
      savedAddresses: [
        {
          address1: 'Office 3, Shahrah-e-Faisal',
          city: 'Karachi',
          province: 'Sindh',
          phone: '+923001234567',
        },
        {
          address1: 'House 12, Street 4',
          city: 'Karachi',
          province: 'Sindh',
          phone: '+923001234567',
        },
      ],
      defaultAddress: { address1: 'Office 3, Shahrah-e-Faisal' },
    });
    // A checkout the signed-in shopper opens is filled in from the default address, offering
    // the book; posted with the session, another fills it in (ADR-585, ADR-587).
    const {
      rows: [variant],
    } = await admin.query<{ id: string }>(
      'SELECT id FROM catalog.variants WHERE shop_id = $1 ORDER BY id LIMIT 1',
      [shop],
    );
    const cart = await client.act(shop, null, 'add', {
      items: [{ variantId: variant!.id, quantity: 1 }],
    });
    if (!cart.ok) throw new Error(`Expected a cart, got ${JSON.stringify(cart)}`);
    const started = await client.startCheckout(shop, cart.token);
    if (!started.ok) throw new Error(`Expected a checkout, got ${JSON.stringify(started)}`);
    const secret = started.path.split('/').at(-1)!;
    const opened = await client.checkoutPage(shop, secret, null, undefined, session);
    const openedHtml = 'html' in opened ? opened.html : '';
    expect(openedHtml).toContain('value="Office 3, Shahrah-e-Faisal"');
    expect(openedHtml.match(/value="use_address"/g)).toHaveLength(2);
    const chosen = await client.checkoutPage(
      shop,
      secret,
      { action: 'use_address', address: home!.id },
      { ip: '203.0.113.7', userAgent: null, account: session },
    );
    expect('html' in chosen && chosen.html).toContain('value="House 12, Street 4"');
    // Without the session, neither.
    const plain = await client.checkoutPage(shop, secret, null);
    expect('html' in plain && plain.html).not.toContain('use_address');

    // Taken out; the other shop has none of them.
    expect(await client.accountAddressDelete(shop, session, home!.id)).toMatchObject([
      { address1: 'Office 3, Shahrah-e-Faisal', default: true },
    ]);
    expect(await client.accountAddresses(other, session)).toBeNull();
    await client.accountLogout(shop, session);
    expect(await client.accountAddresses(shop, session)).toBeNull();
  });
});
