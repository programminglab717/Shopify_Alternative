import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService } from '@hatti/inventory/public';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; path?: string[]; extensions?: { code?: string } }[];
}

const STOCK_SCOPES = ['write_products', 'write_inventory', 'write_locations'];

const LEVEL_FIELDS = 'location { name } available onHand committed reserved safetyStock';

describe.skipIf(!server)('Admin GraphQL API: inventory', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', aProductsOnly: '', aStockReader: '', b: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
    );
    return token;
  }

  async function gql(
    token: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GraphQLResponse> {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: { query, variables },
    });
    return response.json() as GraphQLResponse;
  }

  /** Runs a mutation and returns its payload, failing the test on GraphQL errors. */
  async function mutate(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  async function addLocation(token: string, input: Record<string, unknown>) {
    return mutate(
      token,
      `mutation ($input: LocationAddInput!) {
         locationAdd(input: $input) {
           location { id name isPrimary isActive fulfillsOnlineOrders
                      address { city province provinceCode zip phone formatted } }
           userErrors { field code message }
         }
       }`,
      { input },
    );
  }

  /** A product with a variant per size; returns the variants' inventory item IDs. */
  async function stockedProduct(token: string, title: string, sizes: string[]) {
    const payload = await mutate(
      token,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) {
           product { id variants { id title inventoryItem { id tracked inventoryLevels { available } } } }
           userErrors { code }
         }
       }`,
      { input: { title, options: [{ name: 'Size', values: sizes }] } },
    );
    expect(payload.userErrors).toEqual([]);
    return payload.product as {
      id: string;
      variants: { id: string; inventoryItem: { id: string } }[];
    };
  }

  const SET_QUANTITIES = `
    mutation ($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          id reason referenceDocumentUri
          changes { name delta quantityAfterChange availableAfterChange location { name }
                    item { id tracked } }
        }
        userErrors { field code message }
      }
    }`;

  const ADJUST_QUANTITIES = `
    mutation ($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup { reason changes { name delta quantityAfterChange } }
        userErrors { field code message }
      }
    }`;

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, STOCK_SCOPES);
    tokens.aProductsOnly = await issueToken(shopA, ['write_products']);
    tokens.aStockReader = await issueToken(shopA, ['read_products', 'read_inventory']);
    tokens.b = await issueToken(shopB, STOCK_SCOPES);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('manages locations', async () => {
    // A shop's first location is created when first needed.
    const first = await gql(tokens.a, '{ location { name isPrimary } }');
    expect(first.data?.location).toEqual({ name: 'Main location', isPrimary: true });

    const added = await addLocation(tokens.a, {
      name: 'Karachi store',
      address: { address1: 'Shop 7, Tariq Road', city: 'khi', zip: '75400', phone: '0321-7654321' },
      fulfillsOnlineOrders: false,
    });
    expect(added).toEqual({
      location: {
        id: expect.stringMatching(/^loc_/),
        name: 'Karachi store',
        isPrimary: false,
        isActive: true,
        fulfillsOnlineOrders: false,
        address: {
          city: 'Karachi',
          province: 'Sindh',
          provinceCode: 'SD',
          zip: '75400',
          phone: '+923217654321',
          formatted: ['Shop 7, Tariq Road', 'Karachi 75400', 'Sindh'],
        },
      },
      userErrors: [],
    });
    const invalid = await addLocation(tokens.a, {
      name: 'karachi STORE',
      address: { zip: '7540' },
    });
    expect(invalid.userErrors).toEqual([
      {
        field: ['input', 'address', 'zip'],
        code: 'INVALID',
        message: 'Zip must be a five-digit postcode, like 54000',
      },
    ]);

    const storeId = added.location.id;
    const edited = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         locationEdit(id: $id, input: { name: "Tariq Road store", address: { phone: null } }) {
           location { name version address { phone } } userErrors { code }
         }
       }`,
      { id: storeId },
    );
    expect(edited).toEqual({
      location: { name: 'Tariq Road store', version: 2, address: { phone: null } },
      userErrors: [],
    });

    const primary = await gql(tokens.a, '{ location { id } }');
    const refused = await mutate(
      tokens.a,
      `mutation ($id: ID!) { locationDeactivate(locationId: $id) { location { id } userErrors { field code } } }`,
      { id: primary.data?.location.id },
    );
    expect(refused).toEqual({
      location: null,
      userErrors: [{ field: ['locationId'], code: 'INVALID' }],
    });

    const deactivated = await mutate(
      tokens.a,
      `mutation ($id: ID!) { locationDeactivate(locationId: $id) { location { isActive deactivatedAt } userErrors { code } } }`,
      { id: storeId },
    );
    expect(deactivated.location).toEqual({ isActive: false, deactivatedAt: expect.any(String) });
    const listed = await gql(
      tokens.a,
      `{ active: locations(first: 10) { nodes { name } }
         all: locations(first: 1, includeInactive: true) { nodes { name } pageInfo { hasNextPage endCursor } } }`,
    );
    expect(listed.data?.active.nodes).toEqual([{ name: 'Main location' }]);
    expect(listed.data?.all.pageInfo.hasNextPage).toBe(true);
    const next = await gql(
      tokens.a,
      `query ($after: String) { locations(first: 1, after: $after, includeInactive: true) { nodes { name } } }`,
      {
        after: listed.data?.all.pageInfo.endCursor,
      },
    );
    expect(next.data?.locations.nodes).toEqual([{ name: 'Tariq Road store' }]);

    const deleted = await mutate(
      tokens.a,
      `mutation ($id: ID!) { locationDelete(locationId: $id) { deletedLocationId userErrors { code } } }`,
      { id: storeId },
    );
    expect(deleted).toEqual({ deletedLocationId: storeId, userErrors: [] });
  });

  it('counts, adjusts and reports stock', async () => {
    const warehouse = (
      await addLocation(tokens.a, { name: 'Lahore warehouse', address: { city: 'Lahore' } })
    ).location;
    const product = await stockedProduct(tokens.a, 'Peshawari Chappal', ['8', '9']);
    const [size8, size9] = product.variants.map((variant) => variant.inventoryItem.id) as [
      string,
      string,
    ];
    expect(product.variants[0]!.inventoryItem).toEqual({
      id: size8,
      tracked: false,
      inventoryLevels: [],
    });
    expect(size8).toMatch(/^invi_/);

    const counted = await mutate(tokens.a, SET_QUANTITIES, {
      input: {
        name: 'available',
        reason: 'cycle_count_available',
        referenceDocumentUri: 'https://erp.example.com/counts/7',
        quantities: [
          { inventoryItemId: size8, locationId: warehouse.id, quantity: 6 },
          { inventoryItemId: size9, locationId: warehouse.id, quantity: 1 },
        ],
      },
    });
    expect(counted.userErrors).toEqual([]);
    expect(counted.inventoryAdjustmentGroup).toEqual({
      id: expect.stringMatching(/^adj_/),
      reason: 'cycle_count_available',
      referenceDocumentUri: 'https://erp.example.com/counts/7',
      changes: expect.arrayContaining([
        {
          name: 'on_hand',
          delta: 6,
          quantityAfterChange: 6,
          availableAfterChange: 6,
          location: { name: 'Lahore warehouse' },
          item: { id: size8, tracked: true },
        },
      ]),
    });

    const adjusted = await mutate(tokens.a, ADJUST_QUANTITIES, {
      input: {
        name: 'available',
        reason: 'damaged',
        changes: [{ inventoryItemId: size9, locationId: warehouse.id, delta: -1 }],
      },
    });
    expect(adjusted.inventoryAdjustmentGroup).toEqual({
      reason: 'damaged',
      changes: [{ name: 'on_hand', delta: -1, quantityAfterChange: 0 }],
    });
    const tooMany = await mutate(tokens.a, ADJUST_QUANTITIES, {
      input: {
        name: 'available',
        reason: 'shrinkage',
        changes: [{ inventoryItemId: size9, locationId: warehouse.id, delta: -1 }],
      },
    });
    expect(tooMany).toEqual({
      inventoryAdjustmentGroup: null,
      userErrors: [
        {
          field: ['input', 'changes', '0', 'delta'],
          code: 'INVALID',
          message: "Only 0 on hand at this location; can't remove 1",
        },
      ],
    });
    const stale = await mutate(tokens.a, SET_QUANTITIES, {
      input: {
        name: 'on_hand',
        reason: 'cycle_count_available',
        quantities: [
          { inventoryItemId: size8, locationId: warehouse.id, quantity: 9, compareQuantity: 5 },
        ],
      },
    });
    expect(stale.userErrors).toMatchObject([
      { field: ['input', 'quantities', '0', 'compareQuantity'], code: 'STALE' },
    ]);

    const read = await gql(
      tokens.aStockReader,
      `query ($id: ID!) {
         product(id: $id) {
           totalInventory tracksInventory
           variants { title inventoryQuantity availableForSale inventoryItem { inventoryLevels { ${LEVEL_FIELDS} } } }
         }
       }`,
      { id: product.id },
    );
    expect(read.errors).toBeUndefined();
    expect(read.data?.product).toEqual({
      totalInventory: 6,
      tracksInventory: true,
      variants: [
        {
          title: '8',
          inventoryQuantity: 6,
          availableForSale: true,
          inventoryItem: {
            inventoryLevels: [
              {
                location: { name: 'Lahore warehouse' },
                available: 6,
                onHand: 6,
                committed: 0,
                reserved: 0,
                safetyStock: 0,
              },
            ],
          },
        },
        {
          title: '9',
          inventoryQuantity: 0,
          availableForSale: false,
          inventoryItem: {
            inventoryLevels: [
              {
                location: { name: 'Lahore warehouse' },
                available: 0,
                onHand: 0,
                committed: 0,
                reserved: 0,
                safetyStock: 0,
              },
            ],
          },
        },
      ],
    });

    // Keep selling size 9 at zero, and read its history.
    const updated = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         inventoryItemUpdate(id: $id, input: { inventoryPolicy: CONTINUE }) {
           inventoryItem { inventoryPolicy tracked } userErrors { code }
         }
       }`,
      { id: size9 },
    );
    expect(updated.inventoryItem).toEqual({ inventoryPolicy: 'CONTINUE', tracked: true });
    const history = await gql(
      tokens.aStockReader,
      `query ($id: ID!, $location: ID!) {
         inventoryItem(id: $id) {
           inventoryLevel(locationId: $location) { available }
           changes(first: 1) { nodes { reason delta } pageInfo { hasNextPage endCursor } }
         }
       }`,
      { id: size9, location: warehouse.id },
    );
    expect(history.data?.inventoryItem).toEqual({
      inventoryLevel: { available: 0 },
      changes: {
        nodes: [{ reason: 'damaged', delta: -1 }],
        pageInfo: { hasNextPage: true, endCursor: expect.any(String) },
      },
    });
    const older = await gql(
      tokens.aStockReader,
      `query ($id: ID!, $after: String) { inventoryItem(id: $id) { changes(first: 5, after: $after) { nodes { reason delta } } } }`,
      { id: size9, after: history.data?.inventoryItem.changes.pageInfo.endCursor },
    );
    expect(older.data?.inventoryItem.changes.nodes).toEqual([
      { reason: 'cycle_count_available', delta: 1 },
    ]);
    const available = await gql(
      tokens.aStockReader,
      `query ($id: ID!) { product(id: $id) { variants { availableForSale } } }`,
      {
        id: product.id,
      },
    );
    expect(available.data?.product.variants).toEqual([
      { availableForSale: true },
      { availableForSale: true },
    ]);
  });

  it('loads the stock of a page of products with one query', async () => {
    for (let index = 0; index < 4; index++) {
      await stockedProduct(tokens.a, `Kurta ${index}`, ['S', 'M', 'L']);
    }
    const itemsOf = vi.spyOn(app.get(InventoryService), 'itemsOf');
    try {
      const { data, errors } = await gql(
        tokens.aStockReader,
        '{ products(first: 50) { nodes { totalInventory variants { inventoryQuantity availableForSale inventoryItem { tracked } } } } }',
      );
      expect(errors).toBeUndefined();
      expect(data?.products.nodes.length).toBeGreaterThanOrEqual(4);
      expect(itemsOf).toHaveBeenCalledTimes(1);
    } finally {
      itemsOf.mockRestore();
    }
  });

  it('needs inventory and location scopes', async () => {
    const withoutStock = await gql(
      tokens.aProductsOnly,
      '{ products(first: 1) { nodes { title variants { inventoryQuantity } } } }',
    );
    expect(withoutStock.errors?.[0]).toMatchObject({
      extensions: { code: 'ACCESS_DENIED' },
      message: expect.stringContaining('read_inventory'),
    });
    const locations = await gql(tokens.aStockReader, '{ locations(first: 1) { nodes { id } } }');
    expect(locations.errors?.[0]?.message).toContain('read_locations');
    const write = await gql(
      tokens.aStockReader,
      `mutation { inventoryAdjustQuantities(input: { name: "available", reason: "received", changes: [] }) { userErrors { code } } }`,
    );
    expect(write.errors?.[0]?.message).toContain('write_inventory');
  });

  it('rejects malformed ids', async () => {
    const wrongKind = await gql(tokens.a, `query ($id: ID!) { inventoryItem(id: $id) { id } }`, {
      id: `var_${'0'.repeat(26)}`,
    });
    expect(wrongKind.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    const unknown = await gql(tokens.a, `query ($id: ID!) { inventoryItem(id: $id) { id } }`, {
      id: `invi_${'0'.repeat(26)}`,
    });
    expect(unknown).toEqual({ data: { inventoryItem: null } });

    const product = await stockedProduct(tokens.a, 'Cursor check', ['One']);
    for (const cursor of [
      'bm90LWpzb24',
      Buffer.from(JSON.stringify({ id: 'not-a-uuid' })).toString('base64url'),
    ]) {
      const { errors } = await gql(
        tokens.a,
        `query ($id: ID!, $after: String) { inventoryItem(id: $id) { changes(after: $after) { nodes { delta } } } }`,
        { id: product.variants[0]!.inventoryItem.id, after: cursor },
      );
      expect(errors?.[0]).toMatchObject({
        message: 'Invalid cursor',
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
  });

  it("never exposes or changes another shop's stock or locations", async () => {
    const warehouse = (await addLocation(tokens.a, { name: 'Private warehouse' })).location;
    const product = await stockedProduct(tokens.a, 'Private khussa', ['37']);
    const itemId = product.variants[0]!.inventoryItem.id;
    const counted = await mutate(tokens.a, SET_QUANTITIES, {
      input: {
        name: 'available',
        reason: 'received',
        quantities: [{ inventoryItemId: itemId, locationId: warehouse.id, quantity: 3 }],
      },
    });
    expect(counted.userErrors).toEqual([]);
    const bLocation = (await addLocation(tokens.b, { name: 'B warehouse' })).location;

    const reads = await gql(
      tokens.b,
      `query ($item: ID!, $location: ID!) { inventoryItem(id: $item) { id } location(id: $location) { id } }`,
      { item: itemId, location: warehouse.id },
    );
    expect(reads).toEqual({ data: { inventoryItem: null, location: null } });

    const attempts: [string, string, Record<string, unknown>, string[]][] = [
      [
        'inventorySetQuantities',
        SET_QUANTITIES,
        {
          input: {
            name: 'available',
            reason: 'correction',
            quantities: [{ inventoryItemId: itemId, locationId: bLocation.id, quantity: 0 }],
          },
        },
        ['input', 'quantities', '0', 'inventoryItemId'],
      ],
      [
        'inventoryAdjustQuantities',
        ADJUST_QUANTITIES,
        {
          input: {
            name: 'available',
            reason: 'correction',
            changes: [{ inventoryItemId: itemId, locationId: bLocation.id, delta: -3 }],
          },
        },
        ['input', 'changes', '0', 'inventoryItemId'],
      ],
      [
        'inventoryItemUpdate',
        `mutation ($id: ID!) { inventoryItemUpdate(id: $id, input: { tracked: false }) { userErrors { field code message } } }`,
        { id: itemId },
        ['id'],
      ],
      [
        'locationEdit',
        `mutation ($id: ID!) { locationEdit(id: $id, input: { name: "Mine" }) { userErrors { field code message } } }`,
        { id: warehouse.id },
        ['id'],
      ],
      [
        'locationDeactivate',
        `mutation ($id: ID!) { locationDeactivate(locationId: $id) { userErrors { field code message } } }`,
        { id: warehouse.id },
        ['locationId'],
      ],
      [
        'locationDelete',
        `mutation ($id: ID!) { locationDelete(locationId: $id) { userErrors { field code message } } }`,
        { id: warehouse.id },
        ['locationId'],
      ],
    ];
    for (const [name, query, variables, field] of attempts) {
      const payload = await mutate(tokens.b, query, variables);
      expect(payload.userErrors, name).toEqual([
        expect.objectContaining({ field, code: 'NOT_FOUND' }),
      ]);
    }
    // Shop A's stock at its own location with shop B's location ID is not found either.
    const crossed = await mutate(tokens.a, ADJUST_QUANTITIES, {
      input: {
        name: 'available',
        reason: 'correction',
        changes: [{ inventoryItemId: itemId, locationId: bLocation.id, delta: 1 }],
      },
    });
    expect(crossed.userErrors).toMatchObject([
      { field: ['input', 'changes', '0', 'locationId'], code: 'NOT_FOUND' },
    ]);

    const own = await gql(
      tokens.a,
      `query ($id: ID!) { inventoryItem(id: $id) { tracked inventoryLevels { available location { name } } } }`,
      { id: itemId },
    );
    expect(own.data?.inventoryItem).toEqual({
      tracked: true,
      inventoryLevels: [{ available: 3, location: { name: 'Private warehouse' } }],
    });
  });
});
