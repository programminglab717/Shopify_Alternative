import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { SHOPIFY_INVENTORY_HEADINGS } from '@hatti/catalog/public';
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

/** An ISO 8601 time as the API returns it, e.g. 2026-09-28T09:42:15.755Z. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const LEVEL_FIELDS = 'location { name } available onHand committed reserved safetyStock updatedAt';

/** A file's rows as cells, its byte-order mark aside: the files here quote no cells. */
function cellsOf(csv: string): string[][] {
  const text = csv.trim();
  return text
    .slice(text.indexOf('Handle'))
    .split('\r\n')
    .map((line) => line.split(','));
}

/** A file of rows of cells that need no quotes. */
function fileOf(rows: string[][]): string {
  return rows.map((cells) => cells.join(',')).join('\r\n');
}

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
      // A new key for each request, as a client sends one per thing it means to do.
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
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
          id reason referenceDocumentUri createdAt
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
    // On Pro, which has room for their locations (ADR-154).
    await admin.query(
      `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
       SELECT id, 'pro', 'monthly', now(), now() + interval '1 month'
         FROM control.shops WHERE id IN ($1, $2)`,
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
      createdAt: expect.stringMatching(ISO_TIME),
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
                updatedAt: expect.stringMatching(ISO_TIME),
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
                updatedAt: expect.stringMatching(ISO_TIME),
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

  it('moves stock from a warehouse to a shop in one change (ADR-347)', async () => {
    const warehouse = (
      await addLocation(tokens.a, { name: 'Sialkot warehouse', address: { city: 'Sialkot' } })
    ).location;
    const shop = (
      await addLocation(tokens.a, { name: 'Gulberg shop', address: { city: 'Lahore' } })
    ).location;
    const [ball] = (await stockedProduct(tokens.a, 'Football', ['5'])).variants.map(
      (variant) => variant.inventoryItem.id,
    );
    const counted = await mutate(tokens.a, SET_QUANTITIES, {
      input: {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: ball, locationId: warehouse.id, quantity: 20 }],
      },
    });
    expect(counted.userErrors).toEqual([]);

    const MOVE = `
      mutation ($input: InventoryMoveQuantitiesInput!) {
        inventoryMoveQuantities(input: $input) {
          inventoryAdjustmentGroup {
            reason referenceDocumentUri
            changes { name delta quantityAfterChange location { name } }
          }
          userErrors { field code message }
        }
      }`;
    const sent = (quantity: number) => ({
      input: {
        reason: 'movement_created',
        referenceDocumentUri: 'hatti://transfers/1',
        changes: [
          {
            inventoryItemId: ball,
            quantity,
            from: { locationId: warehouse.id, name: 'available' },
            to: { locationId: shop.id, name: 'available' },
          },
        ],
      },
    });
    expect(await mutate(tokens.a, MOVE, sent(8))).toEqual({
      inventoryAdjustmentGroup: {
        reason: 'movement_created',
        referenceDocumentUri: 'hatti://transfers/1',
        changes: [
          {
            name: 'on_hand',
            delta: -8,
            quantityAfterChange: 12,
            location: { name: 'Sialkot warehouse' },
          },
          { name: 'on_hand', delta: 8, quantityAfterChange: 8, location: { name: 'Gulberg shop' } },
        ],
      },
      userErrors: [],
    });
    expect(await mutate(tokens.a, MOVE, sent(13))).toEqual({
      inventoryAdjustmentGroup: null,
      userErrors: [
        {
          field: ['input', 'changes', '0', 'quantity'],
          code: 'INVALID',
          message: "Only 12 available at the location it's moved from; can't move 13",
        },
      ],
    });
    // Moving needs writing stock, and another shop's item isn't found.
    const readOnly = await gql(tokens.aStockReader, MOVE, sent(1));
    expect(readOnly.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect((await mutate(tokens.b, MOVE, sent(1))).userErrors).toMatchObject([
      { field: ['input', 'changes', '0', 'inventoryItemId'], code: 'NOT_FOUND' },
      { field: ['input', 'changes', '0', 'from', 'locationId'], code: 'NOT_FOUND' },
      { field: ['input', 'changes', '0', 'to', 'locationId'], code: 'NOT_FOUND' },
    ]);
  });

  it('orders goods from a supplier and receives them into stock as they come (ADR-350)', async () => {
    const godown = (
      await addLocation(tokens.a, { name: 'Faisalabad godown', address: { city: 'Faisalabad' } })
    ).location;
    const khaddar = await stockedProduct(tokens.a, 'Khaddar suit', ['S', 'M']);
    const [small, medium] = khaddar.variants.map((variant) => variant.inventoryItem.id) as [
      string,
      string,
    ];
    const supplier = await mutate(
      tokens.a,
      `mutation ($input: SupplierInput!) {
         supplierCreate(input: $input) { supplier { id name phone } userErrors { field code } }
       }`,
      { input: { name: 'Nishat Mills', phone: '0300 7654321' } },
    );
    expect(supplier).toEqual({
      supplier: {
        id: expect.stringMatching(/^sup_/),
        name: 'Nishat Mills',
        phone: '+923007654321',
      },
      userErrors: [],
    });

    const PO_FIELDS = `id name status reference expectedOn totalQuantity receivedQuantity
      totalCost { amount } supplier { name } location { name }
      lines { id variantTitle quantity received unitCost { amount } inventoryItem { id } }`;
    const created = await mutate(
      tokens.a,
      `mutation ($input: PurchaseOrderCreateInput!) {
         purchaseOrderCreate(input: $input) { purchaseOrder { ${PO_FIELDS} } userErrors { field code } }
       }`,
      {
        input: {
          supplierId: supplier.supplier.id,
          locationId: godown.id,
          reference: 'INV-88',
          expectedOn: '2026-11-15',
          lines: [
            { inventoryItemId: small, quantity: 12, unitCost: '2100' },
            { inventoryItemId: medium, quantity: 8, unitCost: '2100.50' },
          ],
        },
      },
    );
    expect(created.userErrors).toEqual([]);
    const order = created.purchaseOrder;
    expect(order).toMatchObject({
      id: expect.stringMatching(/^po_/),
      name: 'PO-1',
      status: 'OPEN',
      reference: 'INV-88',
      expectedOn: '2026-11-15',
      totalQuantity: 20,
      receivedQuantity: 0,
      totalCost: { amount: '42004.00' },
      supplier: { name: 'Nishat Mills' },
      location: { name: 'Faisalabad godown' },
      lines: [
        {
          variantTitle: 'S',
          quantity: 12,
          received: 0,
          unitCost: { amount: '2100.00' },
          inventoryItem: { id: small },
        },
        {
          variantTitle: 'M',
          quantity: 8,
          received: 0,
          unitCost: { amount: '2100.50' },
          inventoryItem: { id: medium },
        },
      ],
    });

    const RECEIVE = `mutation ($id: ID!, $input: PurchaseOrderReceiveInput!) {
      purchaseOrderReceive(id: $id, input: $input) {
        purchaseOrder { status receivedQuantity lines { received } }
        userErrors { field code message }
      }
    }`;
    const [smallLine, mediumLine] = order.lines;
    expect(
      await mutate(tokens.a, RECEIVE, {
        id: order.id,
        input: {
          lines: [
            { lineId: smallLine.id, quantity: 12 },
            { lineId: mediumLine.id, quantity: 5 },
          ],
        },
      }),
    ).toEqual({
      purchaseOrder: {
        status: 'OPEN',
        receivedQuantity: 17,
        lines: [{ received: 12 }, { received: 5 }],
      },
      userErrors: [],
    });
    expect(
      await mutate(tokens.a, RECEIVE, {
        id: order.id,
        input: { lines: [{ lineId: mediumLine.id, quantity: 4 }] },
      }),
    ).toEqual({
      purchaseOrder: null,
      userErrors: [
        {
          field: ['input', 'lines', '0', 'quantity'],
          code: 'INVALID',
          message: "Only 3 still to come of 8; can't receive 4",
        },
      ],
    });
    const stock = await gql(
      tokens.aStockReader,
      `query ($id: ID!) {
         inventoryItem(id: $id) {
           inventoryLevels { onHand location { name } }
           changes(first: 1) { nodes { reason delta referenceDocumentUri } }
         }
       }`,
      { id: small },
    );
    // What one costs is the order's, none having been on hand (ADR-352).
    const costs = await gql(
      tokens.aStockReader,
      `query ($id: ID!) { product(id: $id) { variants { title cost { amount } } } }`,
      { id: khaddar.id },
    );
    expect(costs.data?.product.variants).toEqual([
      { title: 'S', cost: { amount: '2100.00' } },
      { title: 'M', cost: { amount: '2100.50' } },
    ]);
    expect(stock.data?.inventoryItem).toEqual({
      inventoryLevels: [{ onHand: 12, location: { name: 'Faisalabad godown' } }],
      changes: {
        nodes: [
          {
            reason: 'received',
            delta: 12,
            referenceDocumentUri: `hatti://purchase-orders/${order.id}`,
          },
        ],
      },
    });

    const closed = await mutate(
      tokens.a,
      `mutation ($id: ID!) { purchaseOrderClose(id: $id) { purchaseOrder { status closedAt } userErrors { code } } }`,
      { id: order.id },
    );
    expect(closed).toEqual({
      purchaseOrder: { status: 'CLOSED', closedAt: expect.stringMatching(ISO_TIME) },
      userErrors: [],
    });
    const listed = await gql(
      tokens.aStockReader,
      `{ suppliers { name } purchaseOrders(first: 5, status: CLOSED) { nodes { name } pageInfo { hasNextPage } } }`,
    );
    expect(listed.data).toEqual({
      suppliers: [{ name: 'Nishat Mills' }],
      purchaseOrders: { nodes: [{ name: 'PO-1' }], pageInfo: { hasNextPage: false } },
    });

    // Reading needs read_inventory, changing write_inventory; another shop sees none of it.
    const forbidden = await gql(
      tokens.aStockReader,
      `mutation ($id: ID!) { purchaseOrderClose(id: $id) { userErrors { code } } }`,
      { id: order.id },
    );
    expect(forbidden.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const theirs = await gql(
      tokens.b,
      `query ($id: ID!) { purchaseOrder(id: $id) { id } suppliers { id } }`,
      { id: order.id },
    );
    expect(theirs.data).toEqual({ purchaseOrder: null, suppliers: [] });
  });

  it('changes an open purchase order: lines added, changed and removed (ADR-351)', async () => {
    const shed = (
      await addLocation(tokens.a, { name: 'Gujranwala shed', address: { city: 'Gujranwala' } })
    ).location;
    const [one, two, three] = (
      await stockedProduct(tokens.a, 'Steel pateela', ['Small', 'Medium', 'Large'])
    ).variants.map((variant) => variant.inventoryItem.id) as [string, string, string];
    const supplier = await mutate(
      tokens.a,
      `mutation { supplierCreate(input: { name: "Bhatti Metals" }) { supplier { id } userErrors { code } } }`,
    );
    const LINES = `purchaseOrder { status reference lines { id variantTitle quantity received unitCost { amount } } }
      userErrors { field code message }`;
    const created = await mutate(
      tokens.a,
      `mutation ($input: PurchaseOrderCreateInput!) { purchaseOrderCreate(input: $input) { ${LINES} } }`,
      {
        input: {
          supplierId: supplier.supplier.id,
          locationId: shed.id,
          lines: [
            { inventoryItemId: one, quantity: 5 },
            { inventoryItemId: two, quantity: 5 },
          ],
        },
      },
    );
    const [small, medium] = created.purchaseOrder.lines;
    const UPDATE = `mutation ($id: ID!, $input: PurchaseOrderUpdateInput!) {
      purchaseOrderUpdate(id: $id, input: $input) { ${LINES} }
    }`;
    const orderId = (
      await gql(tokens.aStockReader, `{ purchaseOrders(first: 1) { nodes { id } } }`)
    ).data?.purchaseOrders.nodes[0].id;
    expect(
      await mutate(tokens.a, UPDATE, {
        id: orderId,
        input: {
          reference: 'Challan 12',
          linesToAdd: [{ inventoryItemId: three, quantity: 2, unitCost: '3200' }],
          linesToUpdate: [{ lineId: small.id, quantity: 7 }],
          lineIdsToRemove: [medium.id],
        },
      }),
    ).toEqual({
      purchaseOrder: {
        status: 'OPEN',
        reference: 'Challan 12',
        lines: [
          { id: small.id, variantTitle: 'Small', quantity: 7, received: 0, unitCost: null },
          {
            id: expect.stringMatching(/^poli_/),
            variantTitle: 'Large',
            quantity: 2,
            received: 0,
            unitCost: { amount: '3200.00' },
          },
        ],
      },
      userErrors: [],
    });
    expect(
      await mutate(tokens.a, UPDATE, {
        id: orderId,
        input: { linesToAdd: [{ inventoryItemId: one, quantity: 1 }] },
      }),
    ).toEqual({
      purchaseOrder: null,
      userErrors: [
        {
          field: ['input', 'linesToAdd', '0', 'inventoryItemId'],
          code: 'INVALID',
          message: 'The item is on the order already',
        },
      ],
    });
    const forbidden = await gql(tokens.aStockReader, UPDATE, { id: orderId, input: { note: 'x' } });
    expect(forbidden.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it("duplicates a product, its variants' stock tracked as its are with none of it (ADR-343)", async () => {
    const warehouse = (
      await addLocation(tokens.a, { name: 'Multan warehouse', address: { city: 'Multan' } })
    ).location;
    const product = await stockedProduct(tokens.a, 'Kolhapuri', ['40', '41']);
    const [size40] = product.variants.map((variant) => variant.inventoryItem.id);
    const counted = await mutate(tokens.a, SET_QUANTITIES, {
      input: {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: size40, locationId: warehouse.id, quantity: 4 }],
      },
    });
    expect(counted.userErrors).toEqual([]);

    const DUPLICATE = `
      mutation ($id: ID!, $title: String!, $status: ProductStatus) {
        productDuplicate(productId: $id, newTitle: $title, newStatus: $status) {
          newProduct {
            id title handle status
            variants { title sku inventoryItem { tracked inventoryLevels { available } } }
          }
          userErrors { field code message }
        }
      }`;
    const copied = await mutate(tokens.a, DUPLICATE, {
      id: product.id,
      title: 'Kolhapuri - Tan',
      status: 'DRAFT',
    });
    expect(copied).toEqual({
      newProduct: {
        id: expect.stringMatching(/^prod_/),
        title: 'Kolhapuri - Tan',
        handle: 'kolhapuri-tan',
        status: 'DRAFT',
        variants: [
          { title: '40', sku: null, inventoryItem: { tracked: true, inventoryLevels: [] } },
          { title: '41', sku: null, inventoryItem: { tracked: false, inventoryLevels: [] } },
        ],
      },
      userErrors: [],
    });
    expect(copied.newProduct.id).not.toBe(product.id);

    // Another shop's product is not found there.
    expect(await mutate(tokens.b, DUPLICATE, { id: product.id, title: 'Theirs' })).toEqual({
      newProduct: null,
      userErrors: [{ field: ['productId'], code: 'NOT_FOUND', message: 'Product not found' }],
    });
  });

  it('says what runs low, at the threshold the shop sets (ADR-125)', async () => {
    const shopC = newId();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Shop C')`, [shopC]);
    const token = await issueToken(shopC, [...STOCK_SCOPES, 'read_orders']);
    const warehouse = (await addLocation(token, { name: 'Warehouse', address: { city: 'Lahore' } }))
      .location;
    const created = await mutate(
      token,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) {
           product { variants { title inventoryItem { id } } } userErrors { code }
         }
       }`,
      {
        input: {
          title: 'Lawn Kurta',
          status: 'ACTIVE',
          options: [{ name: 'Size', values: ['S', 'M'] }],
        },
      },
    );
    const [small, medium] = (created.product.variants as { inventoryItem: { id: string } }[]).map(
      (variant) => variant.inventoryItem.id,
    );
    const counted = await mutate(token, SET_QUANTITIES, {
      input: {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [
          { inventoryItemId: small, locationId: warehouse.id, quantity: 0 },
          { inventoryItemId: medium, locationId: warehouse.id, quantity: 4 },
        ],
      },
    });
    expect(counted.userErrors).toEqual([]);

    const LOW = `{
      home { lowStock { threshold low out } }
      inventoryLowStock(first: 5) {
        nodes { productTitle variantTitle available inventoryItem { id } }
        pageInfo { hasNextPage }
      }
    }`;
    expect((await gql(token, LOW)).data).toEqual({
      home: { lowStock: { threshold: 5, low: 1, out: 1 } },
      inventoryLowStock: {
        nodes: [
          {
            productTitle: 'Lawn Kurta',
            variantTitle: 'S',
            available: 0,
            inventoryItem: { id: small },
          },
          {
            productTitle: 'Lawn Kurta',
            variantTitle: 'M',
            available: 4,
            inventoryItem: { id: medium },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });

    const changed = await mutate(
      token,
      `mutation {
        inventorySettingsUpdate(input: { lowStockThreshold: 3 }) {
          inventorySettings { lowStockThreshold } userErrors { field code }
        }
      }`,
    );
    expect(changed).toEqual({ inventorySettings: { lowStockThreshold: 3 }, userErrors: [] });
    expect(
      (
        await gql(
          token,
          '{ home { lowStock { low out } } inventorySettings { lowStockThreshold } }',
        )
      ).data,
    ).toEqual({
      home: { lowStock: { low: 0, out: 1 } },
      inventorySettings: { lowStockThreshold: 3 },
    });

    // Stock is read with read_inventory, and changed with write_inventory.
    const denied = await gql(
      tokens.aProductsOnly,
      '{ inventoryLowStock(first: 5) { nodes { variantId } } }',
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const readOnly = await gql(
      tokens.aStockReader,
      'mutation { inventorySettingsUpdate(input: { lowStockThreshold: 1 }) { userErrors { code } } }',
    );
    expect(readOnly.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
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

  it("exports stock as Shopify's inventory CSV, and counts it back from one (ADR-133)", async () => {
    const shop = (
      await addLocation(tokens.a, { name: 'Karachi shop', address: { city: 'Karachi' } })
    ).location;
    const product = await stockedProduct(tokens.a, 'Multani Khussa', ['37', '38']);
    const [size37, size38] = product.variants.map((variant) => variant.inventoryItem.id) as [
      string,
      string,
    ];
    const set = await mutate(tokens.a, SET_QUANTITIES, {
      input: {
        name: 'on_hand',
        reason: 'received',
        quantities: [
          { inventoryItemId: size37, locationId: shop.id, quantity: 4 },
          { inventoryItemId: size38, locationId: shop.id, quantity: 2 },
        ],
      },
    });
    expect(set.userErrors).toEqual([]);

    const EXPORT = `query ($query: String, $locationId: ID) {
      inventoryExport(query: $query, locationId: $locationId) { csv productCount rowCount }
    }`;
    const exported = (
      await gql(tokens.aStockReader, EXPORT, { query: 'Multani', locationId: shop.id })
    ).data?.inventoryExport;
    expect(exported).toMatchObject({ productCount: 1, rowCount: 2 });
    const [header, ...rows] = cellsOf(exported.csv as string);
    expect(header).toEqual([...SHOPIFY_INVENTORY_HEADINGS]);
    const column = (heading: string) => header!.indexOf(heading);
    expect(
      rows.map((row) => [
        row[column('Handle')],
        row[column('Option1 Value')],
        row[column('Location')],
        row[column('On hand (current)')],
      ]),
    ).toEqual([
      ['multani-khussa', '37', 'Karachi shop', '4'],
      ['multani-khussa', '38', 'Karachi shop', '2'],
    ]);

    // Counted: five of the 37s, none of the 38s; but one 38 is sold before the file comes back.
    rows[0]![column('On hand (new)')] = '5';
    rows[1]![column('On hand (new)')] = '0';
    const sold = await mutate(tokens.a, ADJUST_QUANTITIES, {
      input: {
        name: 'available',
        reason: 'correction',
        changes: [{ inventoryItemId: size38, locationId: shop.id, delta: -1 }],
      },
    });
    expect(sold.inventoryAdjustmentGroup).not.toBeNull();
    const elsewhere = [...rows[0]!];
    elsewhere[column('Location')] = 'Quetta shop';
    elsewhere[column('On hand (current)')] = '';
    const IMPORT = `mutation ($csv: String!, $dryRun: Boolean) {
      inventoryImport(csv: $csv, dryRun: $dryRun) {
        rows counted unchanged rowErrors { row column message } rowErrorCount dryRun
        userErrors { field code message }
      }
    }`;
    const csv = fileOf([header!, ...rows, elsewhere]);
    const tried = await mutate(tokens.a, IMPORT, { csv, dryRun: true });
    const rowErrors = [
      {
        row: 3,
        column: 'On hand (current)',
        message:
          'Multani Khussa (38) has 1 on hand at Karachi shop now, not 2 as when the file was ' +
          'exported: export it again',
      },
      { row: 4, column: 'Location', message: 'No active location is named "Quetta shop"' },
    ];
    expect(tried).toEqual({
      rows: 3,
      counted: 1,
      unchanged: 0,
      rowErrors,
      rowErrorCount: 2,
      dryRun: true,
      userErrors: [],
    });
    const LEVEL = `query ($id: ID!, $locationId: ID!) {
      inventoryItem(id: $id) { inventoryLevel(locationId: $locationId) { onHand } }
    }`;
    const onHand = async (id: string) =>
      (await gql(tokens.a, LEVEL, { id, locationId: shop.id })).data?.inventoryItem.inventoryLevel
        .onHand;
    expect(await onHand(size37)).toBe(4);
    const imported = await mutate(tokens.a, IMPORT, { csv });
    expect(imported).toMatchObject({ counted: 1, rowErrors, dryRun: false });
    expect(await onHand(size37)).toBe(5);
    expect(await onHand(size38)).toBe(1);
    // The same file again: the 37s it says were on hand are not any more. Without what was on
    // hand, five is what is on hand already.
    expect(await mutate(tokens.a, IMPORT, { csv: fileOf([header!, rows[0]!]) })).toMatchObject({
      counted: 0,
      unchanged: 0,
      rowErrors: [{ row: 2, column: 'On hand (current)' }],
    });
    const recounted = [...rows[0]!];
    recounted[column('On hand (current)')] = '';
    expect(await mutate(tokens.a, IMPORT, { csv: fileOf([header!, recounted]) })).toMatchObject({
      counted: 0,
      unchanged: 1,
      rowErrors: [],
    });

    // Reading stock is not counting it; a file of nothing is said so.
    const reader = await gql(tokens.aStockReader, IMPORT, { csv });
    expect(reader.errors?.[0]?.message).toContain('write_inventory');
    const blank = await mutate(tokens.a, IMPORT, { csv: '' });
    expect(blank.userErrors).toEqual([
      { field: ['csv'], code: 'BLANK', message: 'The file is empty' },
    ]);
    const noStock = await gql(tokens.aProductsOnly, EXPORT, {});
    expect(noStock.errors?.[0]?.message).toContain('read_inventory');
    const badLocation = await gql(tokens.a, EXPORT, { locationId: 'loc_' + '0'.repeat(26) });
    expect(badLocation.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
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
