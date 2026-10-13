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

const SET = `mutation ($productId: ID!, $components: [ProductBundleComponentInput!]!) {
  productBundleSet(productId: $productId, components: $components) { userErrors { field code } }
}`;

const ORDER = `id subtotalPrice { amount }
  lineItems { title quantity unitPrice { amount } bundle { key title quantity } }`;

describe.skipIf(!server)('Admin GraphQL API: orders of bundles (CAT-11, ADR-410)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  let token = '';
  let location = '';

  async function issueToken(scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, hash, hint, scopes],
    );
    return token;
  }

  async function gql(query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    return response.json<{ data?: Json; errors?: Json[] }>();
  }

  async function data(query: string, variables?: Record<string, unknown>) {
    const body = await gql(query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  /** A product of one variant at `price`, `quantity` of it in stock: its ID and the variant's. */
  async function stocked(title: string, price: string, quantity: number) {
    const created = await data(
      `mutation ($input: ProductCreateInput!) {
        productCreate(input: $input) {
          product { id variants { id inventoryItem { id } } }
        }
      }`,
      { input: { title, status: 'ACTIVE', variants: [{ price }] } },
    );
    const variant = created.product.variants[0];
    await data(
      `mutation ($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { code } }
      }`,
      {
        input: {
          name: 'available',
          reason: 'received',
          quantities: [
            { inventoryItemId: variant.inventoryItem.id, locationId: location, quantity },
          ],
        },
      },
    );
    return { product: created.product.id as string, variant: variant.id as string };
  }

  /** What a product's one variant has available. */
  async function available(productId: string): Promise<number> {
    const read = await data(
      `query ($id: ID!) {
        product(id: $id) { variants { inventoryItem { inventoryLevels { available } } } }
      }`,
      { id: productId },
    );
    return read.variants[0].inventoryItem.inventoryLevels[0].available;
  }

  function place(lineItems: { variantId: string; quantity: number }[]) {
    return gql(
      `mutation ($input: OrderCreateInput!) {
        orderCreate(input: $input) { order { ${ORDER} } userErrors { field code message } }
      }`,
      {
        input: {
          lineItems,
          shippingAddress: {
            name: 'Ayesha Khan',
            phone: '0300-1234567',
            address1: 'House 12, Street 4, Block 5',
            city: 'khi',
          },
        },
      },
    );
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    token = await issueToken([
      'write_products',
      'write_inventory',
      'write_locations',
      'write_orders',
    ]);
    api = await startTestApi(testDb);
    app = api.app;
    location = (await gql('{ location { id } }')).data.location.id;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("sells a bundle as its parts' lines, its price shared, its parts' stock taken and given back", async () => {
    const suit = await stocked('Eid 3-piece suit', '6,000', 0);
    const shirt = await stocked('Lawn shirt', '4,000', 3);
    const dupatta = await stocked('Chiffon dupatta', '2,000', 10);
    const trouser = await stocked('Cotton trouser', '1,000', 10);
    const socks = await stocked('Socks', '400', 4);
    expect(
      await data(SET, {
        productId: suit.product,
        components: [
          { variantId: shirt.variant, quantity: 1 },
          { variantId: dupatta.variant, quantity: 1 },
          { variantId: trouser.variant, quantity: 2 },
        ],
      }),
    ).toEqual({ userErrors: [] });

    // Two suits, and a pair of socks on their own: Rs 16,000 of parts for Rs 12,000.
    const placed = await place([
      { variantId: suit.variant, quantity: 2 },
      { variantId: socks.variant, quantity: 1 },
    ]);
    expect(placed.errors).toBeUndefined();
    const order = placed.data.orderCreate.order;
    const sold = order.lineItems[0].bundle;
    expect(sold).toMatchObject({ title: 'Eid 3-piece suit', quantity: 2 });
    expect(order.lineItems).toEqual([
      { title: 'Lawn shirt', quantity: 2, unitPrice: { amount: '3000.00' }, bundle: sold },
      { title: 'Chiffon dupatta', quantity: 2, unitPrice: { amount: '1500.00' }, bundle: sold },
      { title: 'Cotton trouser', quantity: 4, unitPrice: { amount: '750.00' }, bundle: sold },
      { title: 'Socks', quantity: 1, unitPrice: { amount: '400.00' }, bundle: null },
    ]);
    expect(order.subtotalPrice).toEqual({ amount: '12400.00' });
    expect(await available(shirt.product)).toBe(1);
    expect(await available(trouser.product)).toBe(6);
    expect(await available(suit.product)).toBe(0);

    // Its customer's page shows the suits once, what they hold under them (ADR-411).
    const link = await data(
      'mutation ($id: ID!) { orderLinkCreate(id: $id) { url userErrors { code } } }',
      { id: order.id },
    );
    const page = await app.inject({ method: 'GET', url: new URL(link.url).pathname });
    const flat = page.body.replace(/\s+/g, ' ');
    expect(flat).toContain('<bdi dir="ltr">2 ×</bdi> <bdi>Eid 3-piece suit</bdi>');
    expect(flat).toContain(
      'Includes:</span> <span lang="ur" dir="rtl">اس میں شامل:</span></span> <bdi dir="ltr">2 ×</bdi> <bdi>Lawn shirt</bdi>, <bdi dir="ltr">2 ×</bdi> <bdi>Chiffon dupatta</bdi>, <bdi dir="ltr">4 ×</bdi> <bdi>Cotton trouser</bdi>',
    );
    expect(flat).toContain('<td class="num"><bdi dir="ltr">Rs 12,000</bdi></td>');
    expect(flat).not.toContain('Rs 3,000');

    // A bundle is no line to add to an order: its parts are.
    const edit = await data(
      `mutation ($id: ID!, $input: OrderEditLineItemsInput!) {
        orderEditLineItems(id: $id, input: $input) { userErrors { field code message } }
      }`,
      { id: order.id, input: { addVariants: [{ variantId: suit.variant, quantity: 1 }] } },
    );
    expect(edit.userErrors).toEqual([
      {
        field: ['input', 'addVariants', '0', 'variantId'],
        code: 'INVALID',
        message: '"Eid 3-piece suit" is a bundle: add its parts instead',
      },
    ]);

    // Two more want two shirts; one is left. The bundle's line says which part ran out.
    const short = await place([
      { variantId: socks.variant, quantity: 1 },
      { variantId: suit.variant, quantity: 2 },
    ]);
    expect(short.data.orderCreate.userErrors).toEqual([
      {
        field: ['input', 'lineItems', '1', 'quantity'],
        code: 'OUT_OF_STOCK',
        message: 'Only 1 of "Lawn shirt" left at Main location',
      },
    ]);

    // Cancelled, its parts' stock is back.
    expect(
      await data(
        `mutation ($id: ID!) { orderCancel(id: $id, reason: CUSTOMER) { userErrors { code } } }`,
        { id: order.id },
      ),
    ).toEqual({ userErrors: [] });
    expect(await available(shirt.product)).toBe(3);
    expect(await available(trouser.product)).toBe(10);
  });

  it('does not sell a bundle missing a part', async () => {
    const box = await stocked('Gift box', '3,000', 0);
    const shawl = await stocked('Pashmina shawl', '2,500', 5);
    const scarf = await stocked('Silk scarf', '1,000', 5);
    await data(SET, {
      productId: box.product,
      components: [
        { variantId: shawl.variant, quantity: 1 },
        { variantId: scarf.variant, quantity: 1 },
      ],
    });
    await data(
      `mutation ($input: ProductUpdateInput!) {
        productUpdate(input: $input) { userErrors { code } }
      }`,
      { input: { id: scarf.product, status: 'ARCHIVED' } },
    );
    const refused = await place([{ variantId: box.variant, quantity: 1 }]);
    expect(refused.data.orderCreate).toEqual({
      order: null,
      userErrors: [
        {
          field: ['input', 'lineItems', '0', 'variantId'],
          code: 'INVALID',
          message: `"Gift box" is missing a part, so it can't be sold`,
        },
      ],
    });
    expect(await available(shawl.product)).toBe(5);
  });
});
