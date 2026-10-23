import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { ShopifyStores } from './shopify-stores.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IMPORT = `mutation ($store: String!, $accessToken: String, $dryRun: Boolean) {
  customersImportFromShopify(store: $store, accessToken: $accessToken, dryRun: $dryRun) {
    customers withoutPhone created skipped customerErrorCount addresses dryRun
    customerErrors { customer message }
    addressErrors { customer message }
    userErrors { field code message }
  }
}`;

/** A customer with a number, one with only an address's, one abroad, and one with none. */
const LINES = [
  {
    id: 'gid://shopify/Customer/1',
    firstName: 'Ayesha',
    lastName: 'Khan',
    note: 'Evenings',
    tags: ['vip'],
    defaultEmailAddress: { emailAddress: 'ayesha@example.pk', marketingState: 'SUBSCRIBED' },
    defaultPhoneNumber: { phoneNumber: '+923001234567', marketingState: 'UNSUBSCRIBED' },
    defaultAddress: { id: 'gid://shopify/MailingAddress/12?model_name=CustomerAddress' },
  },
  // Her addresses: one at home, her default; one at work; one abroad; one without a city.
  {
    id: 'gid://shopify/MailingAddress/11?model_name=CustomerAddress',
    firstName: 'Ayesha',
    lastName: 'Khan',
    phone: '042 35761234',
    address1: 'Office 3, Main Boulevard',
    city: 'Lahore',
    province: 'Punjab',
    zip: '54000',
    countryCodeV2: 'PK',
    __parentId: 'gid://shopify/Customer/1',
  },
  {
    id: 'gid://shopify/MailingAddress/12?model_name=CustomerAddress',
    firstName: null,
    lastName: null,
    phone: '0321 1234567',
    address1: 'House 4, Street 2',
    address2: 'DHA Phase 5',
    city: 'Karachi',
    province: 'Sindh',
    countryCodeV2: 'PK',
    __parentId: 'gid://shopify/Customer/1',
  },
  {
    id: 'gid://shopify/MailingAddress/13?model_name=CustomerAddress',
    firstName: 'Ayesha',
    address1: '1 Market St',
    city: 'Dubai',
    countryCodeV2: 'AE',
    __parentId: 'gid://shopify/Customer/1',
  },
  {
    id: 'gid://shopify/MailingAddress/14?model_name=CustomerAddress',
    firstName: 'Ayesha',
    address1: 'Somewhere',
    city: null,
    countryCodeV2: 'PK',
    __parentId: 'gid://shopify/Customer/1',
  },
  {
    id: 'gid://shopify/Customer/2',
    firstName: 'Bilal',
    lastName: null,
    tags: [],
    defaultEmailAddress: null,
    defaultPhoneNumber: null,
    defaultAddress: { phone: '0333 5551234' },
  },
  {
    id: 'gid://shopify/Customer/3',
    firstName: 'Sara',
    lastName: 'Ali',
    tags: [],
    defaultEmailAddress: null,
    defaultPhoneNumber: { phoneNumber: '+14155550100', marketingState: 'NOT_SUBSCRIBED' },
    defaultAddress: null,
  },
  {
    id: 'gid://shopify/Customer/4',
    firstName: 'Hina',
    tags: [],
    defaultEmailAddress: { emailAddress: 'hina@example.pk', marketingState: 'SUBSCRIBED' },
    defaultPhoneNumber: null,
    defaultAddress: null,
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

const shopify = new ShopifyStores(
  async (input, init) => {
    if (String(input).startsWith('https://storage.googleapis.com/')) return new Response(LINES);
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const data = query.includes('shop {')
      ? { shop: { name: 'Zari Kurtas' } }
      : query.includes('bulkOperationRunQuery')
        ? {
            bulkOperationRunQuery: {
              bulkOperation: { id: 'gid://shopify/BulkOperation/6', status: 'CREATED' },
              userErrors: [],
            },
          }
        : {
            node: {
              id: 'gid://shopify/BulkOperation/6',
              status: 'COMPLETED',
              url: 'https://storage.googleapis.com/shopify/customers.jsonl',
            },
          };
    return Response.json({ data });
  },
  { sleep: async () => {} },
);

describe.skipIf(!server)("Admin GraphQL API: customers from a Shopify store's Admin API", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  let token = '';

  async function gql(query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    const { token: issued, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, hash, hint, ['write_customers', 'read_customers']],
    );
    token = issued;
    api = await startTestApi(testDb, { shopifyStores: shopify });
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("counts the store's customers, then takes those with Pakistani numbers, as Shopify's export (ADR-755)", async () => {
    const variables = { store: 'zari-kurtas', accessToken: 'shpat_1' };
    const abroad = {
      customer: 'Sara Ali',
      message: '"+14155550100" is not a Pakistani mobile number, like 0300 1234567',
    };
    expect(
      (await gql(IMPORT, { ...variables, dryRun: true })).data?.customersImportFromShopify,
    ).toEqual({
      customers: 3,
      withoutPhone: 1,
      created: 2,
      skipped: 0,
      customerErrorCount: 1,
      addresses: 0,
      dryRun: true,
      customerErrors: [abroad],
      addressErrors: [],
      userErrors: [],
    });
    // Her addresses in Pakistan go into her book: one without a city is said (ADR-784).
    expect((await gql(IMPORT, variables)).data?.customersImportFromShopify).toMatchObject({
      created: 2,
      skipped: 0,
      customerErrors: [abroad],
      addresses: 2,
      addressErrors: [
        { customer: 'Ayesha Khan', message: "An address was not kept: City can't be blank" },
      ],
    });
    const { data } = await gql(`{
      customers(first: 10) {
        nodes {
          name email note tags
          emailMarketingConsent { marketingState }
          smsMarketingConsent { marketingState }
          savedAddresses { name phone address1 address2 city province zip }
        }
      }
    }`);
    expect(data?.customers.nodes).toEqual(
      expect.arrayContaining([
        {
          name: 'Ayesha Khan',
          email: 'ayesha@example.pk',
          note: 'Evenings',
          tags: ['vip'],
          emailMarketingConsent: { marketingState: 'SUBSCRIBED' },
          smsMarketingConsent: { marketingState: 'UNSUBSCRIBED' },
          // Her default first, named as she is where it has no name; a landline's is reached
          // on her mobile.
          savedAddresses: [
            {
              name: 'Ayesha Khan',
              phone: '+923211234567',
              address1: 'House 4, Street 2',
              address2: 'DHA Phase 5',
              city: 'Karachi',
              province: 'Sindh',
              zip: null,
            },
            {
              name: 'Ayesha Khan',
              phone: '+923001234567',
              address1: 'Office 3, Main Boulevard',
              address2: null,
              city: 'Lahore',
              province: 'Punjab',
              zip: '54000',
            },
          ],
        },
        expect.objectContaining({ name: 'Bilal', email: null, savedAddresses: [] }),
      ]),
    );

    // Again: the customers are here, and left as they are.
    expect((await gql(IMPORT, variables)).data?.customersImportFromShopify).toMatchObject({
      created: 0,
      skipped: 2,
      addresses: 0,
      addressErrors: [],
    });
  });
});
