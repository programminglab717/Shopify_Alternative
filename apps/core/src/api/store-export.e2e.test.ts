import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { PublicSite, generateAccessToken, type StaffRole } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { StoreExportService } from '@hatti/files/public';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { xlsxParts as unzip } from '@hatti/xlsx/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeExportBuilder } from '../store-export.js';
import { startTestApi, type TestApi } from '../testing/api.js';
import { NO_LONGER_OWNER, StoreExports } from '../worker/store-exports.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();
const PASSWORD = 'correct horse battery staple';

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const EXPORTS = '{ storeExports { id status size error url } }';
const CREATE = `mutation { storeExportCreate {
  storeExport { id status url } userErrors { code message }
} }`;

describe.skipIf(!server)('Admin GraphQL API: the whole store exported (ADM-10, ADR-415)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let system: Database;
  let worker: StoreExports;
  const shop = newId();
  let app = '';
  /** The shop's owner, signed in: there is one. */
  let owner: { token: string; id: string };

  const post = (url: string, payload: unknown, token?: string) =>
    api.app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  /** A member of the shop's staff in `role`, signed in, with a second factor where it needs one. */
  async function member(role: StaffRole): Promise<{ token: string; id: string }> {
    const email = `export-${randomBytes(4).toString('hex')}@example.pk`;
    const signedUp = await post('/auth/sign-up', { email, password: PASSWORD, name: 'Sana Iqbal' });
    expect(signedUp.statusCode).toBe(201);
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    const id = fromPublicId(body.user.id, 'user')!;
    await admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [id, shop, role],
    );
    if (role === 'owner' || role === 'manager') {
      const setup = await post('/auth/two-step/totp/setup', {}, body.accessToken);
      const { secret } = setup.json() as { secret: string };
      const code = totp(base32Decode(secret), Date.now());
      expect(
        (await post('/auth/two-step/totp/confirm', { code }, body.accessToken)).statusCode,
      ).toBe(200);
    }
    return { token: body.accessToken, id };
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: token.startsWith('hat_')
        ? { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() }
        : {
            authorization: `Bearer ${token}`,
            'x-hatti-shop-id': toPublicId('shop', shop),
            'idempotency-key': randomUUID(),
          },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
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
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    api = await startTestApi(testDb);
    system = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'store-export-worker-test',
    });
    worker = new StoreExports(
      new StoreExportService(system, api.storage),
      storeExportBuilder(system, new PublicSite('http://localhost:4000')),
    );
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [
        shop,
        hash,
        hint,
        ['write_products', 'write_orders', 'write_customers', 'read_customers', 'read_orders'],
      ],
    );
    app = token;
  });

  afterAll(async () => {
    await system?.close();
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("is made by the worker as the owner who asked, a ZIP of each part's own export", async () => {
    // A product, a customer and an order of theirs.
    const product = await data(
      app,
      `mutation ($input: ProductCreateInput!) {
        productCreate(input: $input) { product { variants { id } } }
      }`,
      { input: { title: 'Lawn suit', status: 'ACTIVE', variants: [{ price: '4,500' }] } },
    );
    await data(
      app,
      'mutation ($input: CustomerCreateInput!) { customerCreate(input: $input) { userErrors { code } } }',
      { input: { phone: '0300 1234567', name: 'Ayesha Khan' } },
    );
    const order = await data(
      app,
      `mutation ($input: OrderCreateInput!) {
        orderCreate(input: $input) { order { name } userErrors { field code } }
      }`,
      {
        input: {
          lineItems: [{ variantId: product.product.variants[0].id, quantity: 2 }],
          shippingAddress: {
            name: 'Ayesha Khan',
            phone: '0300-1234567',
            address1: 'House 12, Street 4, Block 5',
            city: 'lhr',
          },
        },
      },
    );
    expect(order.userErrors).toEqual([]);

    owner = await member('owner');
    expect(await data(owner.token, EXPORTS)).toEqual([]);
    const asked = await data(owner.token, CREATE);
    expect(asked).toMatchObject({
      storeExport: { status: 'PENDING', url: null },
      userErrors: [],
    });
    expect((await data(owner.token, CREATE)).userErrors).toEqual([
      { code: 'IN_USE', message: 'An export is being made: it is ready in a few minutes' },
    ]);

    expect(await worker.sweep()).toBe(1);
    const [ready] = await data(owner.token, EXPORTS);
    expect(ready).toMatchObject({ id: asked.storeExport.id, status: 'READY', error: null });
    expect(ready.size).toBeGreaterThan(0);

    // The link downloads it.
    const link = new URL(ready.url);
    const downloaded = await api.app.inject({ method: 'GET', url: link.pathname + link.search });
    expect(downloaded.statusCode).toBe(200);
    const files = unzip(downloaded.rawPayload);
    expect([...files.keys()]).toEqual([
      'README.txt',
      'products.csv',
      'inventory.csv',
      'customers.csv',
      'orders.csv',
      'order-line-items.csv',
      'redirects.csv',
    ]);
    expect(files.get('README.txt')).toContain(`by ${toPublicId('user', owner.id)}`);
    expect(files.get('README.txt')).toContain('products.csv: 1 product,');
    expect(files.get('README.txt')).toContain('orders.csv: 1 order,');
    expect(files.get('products.csv')).toContain('lawn-suit,Lawn suit');
    expect(files.get('customers.csv')).toContain('Ayesha Khan');
    expect(files.get('orders.csv')).toContain(order.order.name);
    expect(files.get('order-line-items.csv')).toContain('Lawn suit');
    // Each part as the owner exported it: in the audit log under their name.
    const { rows: audit } = await admin.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM platform.audit_log WHERE action LIKE '%export%' ORDER BY id`,
    );
    expect(audit.map((row) => row.action)).toContain('store.export_requested');
    expect(audit.map((row) => row.action)).toContain('orders.exported');
    expect(new Set(audit.map((row) => row.actor_id))).toEqual(new Set([owner.id]));
  });

  it('is the owner’s alone, and not made once whoever asked is no longer the owner', async () => {
    const manager = await member('manager');
    for (const token of [manager.token, app]) {
      for (const query of [EXPORTS, CREATE]) {
        const denied = await gql(token, query);
        expect(denied.errors?.[0].extensions.code).toBe('ACCESS_DENIED');
      }
    }

    await admin.query('DELETE FROM files.store_exports');
    expect((await data(owner.token, CREATE)).userErrors).toEqual([]);
    await admin.query("UPDATE identity.memberships SET role = 'manager' WHERE user_id = $1", [
      owner.id,
    ]);
    expect(await worker.sweep()).toBe(0);
    await admin.query("UPDATE identity.memberships SET role = 'owner' WHERE user_id = $1", [
      owner.id,
    ]);
    expect(await data(owner.token, EXPORTS)).toEqual([
      expect.objectContaining({ status: 'FAILED', error: NO_LONGER_OWNER, url: null }),
    ]);
  });
});
