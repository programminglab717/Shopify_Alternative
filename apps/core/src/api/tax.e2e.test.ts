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

const SETTINGS = '{ taxSettings { rate taxDelivery } shop { taxesIncluded taxShipping } }';

const UPDATE = `mutation ($input: TaxSettingsUpdateInput!) {
  taxSettingsUpdate(input: $input) {
    taxSettings { rate taxDelivery } userErrors { field code message }
  }
}`;

const TAX_LINE = 'title rate ratePercentage price { amount }';

const ORDER_CREATE = `mutation ($input: OrderCreateInput!) {
  orderCreate(input: $input) {
    order {
      totalPrice { amount } taxesIncluded totalTax { amount } taxLines { ${TAX_LINE} }
      lineItems { title taxable taxLines { ${TAX_LINE} } }
    }
    userErrors { field code message }
  }
}`;

const ADDRESS = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  address1: 'House 12, Street 4, Block 5',
  city: 'khi',
};

describe.skipIf(!server)('Admin GraphQL API: sales tax', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const other = newId();
  const tokens = { owner: '', reader: '', products: '', other: '' };

  /** A tax line as the API gives it. */
  const line = (rate: number, amount: string) => ({
    title: 'Sales tax',
    rate: rate / 100,
    ratePercentage: rate,
    price: { amount },
  });

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
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

  async function mutate(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  /**
   * A product at a price, taxed or not, at a tax code's category or the shop's rate, with stock at
   * the primary location; its variant.
   */
  async function stocked(
    token: string,
    title: string,
    price: string,
    taxable: boolean,
    taxCode: string | null = null,
  ) {
    const created = await mutate(
      token,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) {
           product { variants { id taxable taxCode inventoryItem { id } } } userErrors { code }
         }
       }`,
      { input: { title, status: 'ACTIVE', variants: [{ price, taxable, taxCode }] } },
    );
    const [variant] = created.product.variants as {
      id: string;
      taxable: boolean;
      taxCode: string | null;
      inventoryItem: { id: string };
    }[];
    expect([variant!.taxable, variant!.taxCode]).toEqual([taxable, taxCode]);
    const location = (await gql(token, '{ location { id } }')).data?.location.id as string;
    const counted = await mutate(
      token,
      `mutation ($input: InventorySetQuantitiesInput!) {
         inventorySetQuantities(input: $input) { userErrors { code } }
       }`,
      {
        input: {
          name: 'available',
          reason: 'received',
          quantities: [
            { inventoryItemId: variant!.inventoryItem.id, locationId: location, quantity: 5 },
          ],
        },
      },
    );
    expect(counted.userErrors).toEqual([]);
    return variant!.id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'B')`, [
      shop,
      other,
    ]);
    const owner = [
      'write_products',
      'write_inventory',
      'write_locations',
      'write_orders',
      'write_settings',
    ];
    tokens.owner = await issueToken(shop, owner);
    tokens.reader = await issueToken(shop, ['read_settings']);
    tokens.products = await issueToken(shop, ['write_products']);
    tokens.other = await issueToken(other, owner);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("keeps the rate a shop sets, and the tax each order's prices include", async () => {
    // None until the shop sets a rate; prices include whatever there is.
    expect((await gql(tokens.owner, SETTINGS)).data).toEqual({
      taxSettings: { rate: null, taxDelivery: false },
      shop: { taxesIncluded: true, taxShipping: false },
    });
    expect(await mutate(tokens.owner, UPDATE, { input: { rate: 18.555 } })).toEqual({
      taxSettings: null,
      userErrors: [
        {
          field: ['input', 'rate'],
          code: 'INVALID',
          message:
            'Rate must be a percentage from 0.01 to 50, with two decimals at most, like 18 or ' +
            '17.5',
        },
      ],
    });
    expect(await mutate(tokens.owner, UPDATE, { input: { rate: 18, taxDelivery: true } })).toEqual({
      taxSettings: { rate: 18, taxDelivery: true },
      userErrors: [],
    });
    // Those who read the shop's settings read it; changing it is theirs who write them.
    expect((await gql(tokens.reader, SETTINGS)).data).toEqual({
      taxSettings: { rate: 18, taxDelivery: true },
      shop: { taxesIncluded: true, taxShipping: true },
    });
    for (const [token, query] of [
      [tokens.products, '{ taxSettings { rate } }'],
      [tokens.reader, UPDATE],
    ] as const) {
      const denied = await gql(token, query, { input: { rate: 17 } });
      expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    }

    // Rs 336 off, shared by price: the kurta is paid Rs 2,124, which includes Rs 324 at 18%; the
    // book, whose price includes none, nothing; delivery's Rs 236, Rs 36. The total is what it
    // was: the tax is in it.
    const kurta = await stocked(tokens.owner, 'Kurta', '2,360', true);
    const book = await stocked(tokens.owner, 'Quran', '1,000', false);
    const placed = await mutate(tokens.owner, ORDER_CREATE, {
      input: {
        lineItems: [
          { variantId: kurta, quantity: 1 },
          { variantId: book, quantity: 1 },
        ],
        shippingAddress: ADDRESS,
        shippingPrice: '236',
        discount: '336',
      },
    });
    expect(placed).toEqual({
      order: {
        totalPrice: { amount: '3260.00' },
        taxesIncluded: true,
        totalTax: { amount: '360.00' },
        taxLines: [line(18, '360.00')],
        lineItems: [
          { title: 'Kurta', taxable: true, taxLines: [line(18, '324.00')] },
          { title: 'Quran', taxable: false, taxLines: [] },
        ],
      },
      userErrors: [],
    });

    // Each shop its own.
    expect((await gql(tokens.other, SETTINGS)).data?.taxSettings).toEqual({
      rate: null,
      taxDelivery: false,
    });
  });

  it("taxes a variant at its tax code's category's rate (ADR-097)", async () => {
    const CATEGORIES = `mutation ($input: TaxSettingsUpdateInput!) {
      taxSettingsUpdate(input: $input) {
        taxSettings { rate categories { code name rate } } userErrors { field code }
      }
    }`;
    const reduced = { code: 'REDUCED', name: 'Reduced rate', rate: 10 };
    // Each code once, in any letter case.
    expect(
      await mutate(tokens.owner, CATEGORIES, {
        input: { categories: [reduced, { ...reduced, code: 'reduced', rate: 12 }] },
      }),
    ).toEqual({
      taxSettings: null,
      userErrors: [{ field: ['input', 'categories', '1', 'code'], code: 'TAKEN' }],
    });
    expect(await mutate(tokens.owner, CATEGORIES, { input: { categories: [reduced] } })).toEqual({
      taxSettings: { rate: 18, categories: [reduced] },
      userErrors: [],
    });
    // A variant naming it, as Shopify's taxCode: Rs 1,100 at 10% includes Rs 100.
    const ajrak = await stocked(tokens.owner, 'Ajrak', '1,100', true, 'REDUCED');
    const placed = await mutate(tokens.owner, ORDER_CREATE, {
      input: { lineItems: [{ variantId: ajrak, quantity: 1 }], shippingAddress: ADDRESS },
    });
    expect(placed.order).toMatchObject({
      totalTax: { amount: '100.00' },
      taxLines: [line(10, '100.00')],
      lineItems: [{ title: 'Ajrak', taxable: true, taxLines: [line(10, '100.00')] }],
    });
  });

  it('gives back its share of the tax with refunds, and the sales report adds it up (ADR-105)', async () => {
    await mutate(tokens.owner, UPDATE, { input: { rate: 18, taxDelivery: false } });
    const kurta = await stocked(tokens.owner, 'Kurta', '2,360', true);
    const placed = await mutate(
      tokens.owner,
      `mutation ($input: OrderCreateInput!) {
         orderCreate(input: $input) { order { id totalTax { amount } } userErrors { message } }
       }`,
      {
        input: {
          lineItems: [{ variantId: kurta, quantity: 1 }],
          shippingAddress: ADDRESS,
          paymentMethod: 'PREPAID',
        },
      },
    );
    const REFUND = `mutation ($id: ID!, $amount: String!) {
      orderRefund(id: $id, input: { amount: $amount, method: CASH }) {
        refund { totalTax { amount } }
        order { totalTax { amount } currentTotalTax { amount } }
        userErrors { message }
      }
    }`;
    // Rs 1,000 of Rs 2,360 carries Rs 152.54 of its Rs 360.
    expect(await mutate(tokens.owner, REFUND, { id: placed.order.id, amount: '1,000' })).toEqual({
      refund: { totalTax: { amount: '152.54' } },
      order: { totalTax: { amount: '360.00' }, currentTotalTax: { amount: '207.46' } },
      userErrors: [],
    });

    // The report's taxes are its orders', none of whose items came back.
    const now = Date.now();
    const report = await mutate(
      tokens.owner,
      `query ($from: DateTime!, $before: DateTime!) {
         salesReport(placedFrom: $from, placedBefore: $before) {
           totals { totalSales { amount } taxes { amount } }
         }
       }`,
      {
        from: new Date(now - 86_400_000).toISOString(),
        before: new Date(now + 86_400_000).toISOString(),
      },
    );
    const orders = await mutate(
      tokens.owner,
      '{ orders(first: 50) { nodes { totalTax { amount } cancelledAt } } }',
    );
    const kept = (orders.nodes as Json[]).filter((order) => order.cancelledAt === null);
    const sum = kept.reduce((total, order) => total + Number(order.totalTax.amount), 0);
    expect(report.totals.taxes.amount).toBe(sum.toFixed(2));
    expect(Number(report.totals.taxes.amount)).toBeGreaterThanOrEqual(360);
  });

  it('says the tax a draft includes, as the order it becomes keeps it (ADR-106)', async () => {
    await mutate(tokens.owner, UPDATE, { input: { rate: 18, taxDelivery: true, categories: [] } });
    const kurta = await stocked(tokens.owner, 'Kurta', '2,360', true);
    const book = await stocked(tokens.owner, 'Quran', '1,000', false);
    const DRAFT = `id totalPrice { amount } taxesIncluded totalTax { amount } taxLines { ${TAX_LINE} }`;
    const create = () =>
      mutate(
        tokens.owner,
        `mutation ($input: DraftOrderInput!) {
           draftOrderCreate(input: $input) { draftOrder { ${DRAFT} } userErrors { field code } }
         }`,
        {
          input: {
            lineItems: [
              { variantId: kurta, quantity: 1 },
              { variantId: book, quantity: 1 },
            ],
            shippingAddress: ADDRESS,
            shippingPrice: '236',
            discount: '336',
          },
        },
      );
    // As the order it becomes: Rs 324 of the kurta's Rs 2,124, none of the book, and Rs 36 of
    // delivery's Rs 236.
    const created = await create();
    expect(created).toEqual({
      draftOrder: {
        id: expect.any(String),
        totalPrice: { amount: '3260.00' },
        taxesIncluded: true,
        totalTax: { amount: '360.00' },
        taxLines: [line(18, '360.00')],
      },
      userErrors: [],
    });
    const completed = await mutate(
      tokens.owner,
      `mutation ($id: ID!) {
         draftOrderComplete(id: $id) {
           draftOrder { totalTax { amount } order { totalTax { amount } } } userErrors { code }
         }
       }`,
      { id: created.draftOrder.id },
    );
    expect(completed).toEqual({
      draftOrder: { totalTax: { amount: '360.00' }, order: { totalTax: { amount: '360.00' } } },
      userErrors: [],
    });

    // Once placed, its order's, whatever the shop's rate since; an open one's, the shop's now.
    await mutate(tokens.owner, UPDATE, { input: { rate: null } });
    const open = await create();
    expect(open.draftOrder).toMatchObject({ totalTax: { amount: '0.00' }, taxLines: [] });
    const drafts = await gql(
      tokens.owner,
      `{ draftOrders(first: 10) { nodes { id totalTax { amount } taxLines { ${TAX_LINE} } } } }`,
    );
    expect(drafts.data?.draftOrders.nodes).toEqual([
      { id: open.draftOrder.id, totalTax: { amount: '0.00' }, taxLines: [] },
      { id: created.draftOrder.id, totalTax: { amount: '360.00' }, taxLines: [line(18, '360.00')] },
    ]);
  });

  it('keeps the numbers FBR registered the shop under, which its invoices name (ADR-190)', async () => {
    const REGISTRATION = `mutation ($input: TaxSettingsUpdateInput!) {
      taxSettingsUpdate(input: $input) {
        taxSettings { ntn strn } userErrors { field code }
      }
    }`;
    expect(
      await mutate(tokens.owner, REGISTRATION, {
        input: { ntn: '1234567 8', strn: '32-77-8761-758-52' },
      }),
    ).toEqual({ taxSettings: { ntn: '1234567-8', strn: '3277876175852' }, userErrors: [] });
    expect(await mutate(tokens.owner, REGISTRATION, { input: { strn: '12' } })).toEqual({
      taxSettings: null,
      userErrors: [{ field: ['input', 'strn'], code: 'INVALID' }],
    });
    expect((await gql(tokens.reader, '{ taxSettings { ntn strn } }')).data).toEqual({
      taxSettings: { ntn: '1234567-8', strn: '3277876175852' },
    });
    expect(await mutate(tokens.owner, REGISTRATION, { input: { ntn: null, strn: '' } })).toEqual({
      taxSettings: { ntn: null, strn: null },
      userErrors: [],
    });
  });
});
