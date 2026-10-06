import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { xlsxRows } from '@hatti/xlsx/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

const SCOPES = ['write_products', 'write_inventory', 'write_locations', 'write_orders'];

const ADDRESS = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  address1: 'House 12, Street 4, Block 5',
  address2: 'Gulshan-e-Iqbal',
  landmark: 'Near Jamia Masjid',
  city: 'khi',
  zip: '75300',
};

const ORDER_FIELDS = `
  id name number stage status confirmationStatus financialStatus fulfillmentStatus
  paymentMethod source phone email note tags cancelReason version createdAt updatedAt
  shippingAddress { name phone address2 landmark city province formatted }
  lineItems { title variantTitle sku quantity unitPrice { formatted } totalPrice { formatted } variantId }
  subtotalPrice { formatted } totalDiscounts { formatted } totalShippingPrice { formatted }
  totalPrice { formatted } amountPaid { formatted } codAmount { formatted }
  location { name }
  risk { score level reasons { code message weight } }
`;

const ORDER_CREATE = `
  mutation ($input: OrderCreateInput!) {
    orderCreate(input: $input) { order { ${ORDER_FIELDS} } userErrors { field code message } }
  }`;

describe.skipIf(!server)('Admin GraphQL API: orders', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', aReader: '', aNoOrders: '', b: '' };

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

  /** A product with a variant per size at a price, with stock at the primary location. */
  async function stockedVariants(token: string, title: string, sizes: string[], stock: number) {
    const created = await mutate(
      token,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) {
           product { variants { id inventoryItem { id } } } userErrors { code }
         }
       }`,
      {
        input: {
          title,
          status: 'ACTIVE',
          options: [{ name: 'Size', values: sizes }],
          variants: sizes.map((size) => ({
            optionValues: [size],
            price: '3,499',
            sku: `SKU-${size}`,
          })),
        },
      },
    );
    const variants = created.product.variants as { id: string; inventoryItem: { id: string } }[];
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
          quantities: variants.map((variant) => ({
            inventoryItemId: variant.inventoryItem.id,
            locationId: location,
            quantity: stock,
          })),
        },
      },
    );
    expect(counted.userErrors).toEqual([]);
    return variants.map((variant) => variant.id);
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, SCOPES);
    tokens.aReader = await issueToken(shopA, ['read_orders']);
    tokens.aNoOrders = await issueToken(shopA, ['write_products']);
    tokens.b = await issueToken(shopB, SCOPES);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('places an order, finds it, confirms it and records payment', async () => {
    const [size8, size9] = await stockedVariants(tokens.a, 'Peshawari Chappal', ['8', '9'], 5);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [
          { variantId: size8, quantity: 2 },
          { variantId: size9, quantity: 1, price: '3,000' },
        ],
        shippingAddress: ADDRESS,
        email: 'ayesha@example.com',
        shippingPrice: '250',
        discount: '499',
        tags: ['whatsapp'],
      },
    });
    expect(created.userErrors).toEqual([]);
    const order = created.order;
    expect(order).toMatchObject({
      id: expect.stringMatching(/^ord_/),
      name: '#1001',
      number: 1001,
      stage: 'NEEDS_CONFIRMATION',
      status: 'OPEN',
      confirmationStatus: 'PENDING',
      financialStatus: 'PENDING',
      fulfillmentStatus: 'UNFULFILLED',
      paymentMethod: 'CASH_ON_DELIVERY',
      source: 'API',
      phone: '+923001234567',
      shippingAddress: {
        name: 'Ayesha Khan',
        address2: 'Gulshan-e-Iqbal',
        landmark: 'Near Jamia Masjid',
        city: 'Karachi',
        province: 'Sindh',
        formatted: [
          'Ayesha Khan',
          'House 12, Street 4, Block 5',
          'Gulshan-e-Iqbal',
          'Near Jamia Masjid',
          'Karachi 75300',
          'Sindh',
        ],
      },
      lineItems: [
        {
          title: 'Peshawari Chappal',
          variantTitle: '8',
          sku: 'SKU-8',
          quantity: 2,
          unitPrice: { formatted: 'Rs 3,499' },
          totalPrice: { formatted: 'Rs 6,998' },
          variantId: size8,
        },
        { variantTitle: '9', unitPrice: { formatted: 'Rs 3,000' } },
      ],
      subtotalPrice: { formatted: 'Rs 9,998' },
      totalDiscounts: { formatted: 'Rs 499' },
      totalShippingPrice: { formatted: 'Rs 250' },
      totalPrice: { formatted: 'Rs 9,749' },
      amountPaid: { formatted: 'Rs 0' },
      codAmount: { formatted: 'Rs 9,749' },
      location: { name: 'Main location' },
      risk: {
        score: 0.1,
        level: 'LOW',
        reasons: [{ code: 'first_order', message: 'First order from this number', weight: 0.1 }],
      },
      createdAt: expect.stringMatching(/Z$/),
    });

    // The stock is committed: size 8 has 3 left to sell.
    const stock = await gql(
      tokens.a,
      `query ($id: ID!) { product(id: $id) { variants { inventoryQuantity } } }`,
      {
        id: (await gql(tokens.a, '{ products(first: 1) { nodes { id } } }')).data?.products.nodes[0]
          .id,
      },
    );
    expect(stock.data?.product.variants).toEqual([
      { inventoryQuantity: 3 },
      { inventoryQuantity: 4 },
    ]);

    const found = await gql(
      tokens.aReader,
      `{ byPhone: orders(first: 5, query: "+92 300 123 4567") { nodes { name } }
         byName: orders(first: 5, query: "ayesha") { nodes { name } }
         waiting: orders(first: 5, stage: NEEDS_CONFIRMATION) { nodes { name } }
         filtered: orders(first: 5, query: "ayesha stage:needs_confirmation -status:closed") {
           nodes { name }
         }
         none: orders(first: 5, query: "payment_method:prepaid") { nodes { name } }
         orderStageCounts { stage count } }`,
    );
    expect(found.errors).toBeUndefined();
    expect(found.data?.byPhone.nodes).toEqual([{ name: '#1001' }]);
    expect(found.data?.byName.nodes).toEqual([{ name: '#1001' }]);
    expect(found.data?.waiting.nodes).toEqual([{ name: '#1001' }]);
    expect(found.data?.filtered.nodes).toEqual([{ name: '#1001' }]);
    expect(found.data?.none.nodes).toEqual([]);
    expect(found.data?.orderStageCounts).toContainEqual({ stage: 'NEEDS_CONFIRMATION', count: 1 });
    // A filter the search doesn't know is refused, saying which it knows.
    const unknown = await gql(
      tokens.aReader,
      '{ orders(first: 5, query: "stag:to_pack") { nodes { name } } }',
    );
    expect(unknown.errors?.[0]).toMatchObject({
      message: expect.stringContaining("Orders can't be filtered by stag; filters are stage,"),
      extensions: { code: 'BAD_USER_INPUT' },
    });

    const confirmed = await mutate(
      tokens.a,
      `mutation ($id: ID!) { orderConfirm(id: $id) { order { stage confirmationStatus confirmedAt } userErrors { code } } }`,
      { id: order.id },
    );
    expect(confirmed.order).toMatchObject({
      stage: 'TO_PACK',
      confirmationStatus: 'CONFIRMED',
      confirmedAt: expect.any(String),
    });
    const paid = await mutate(
      tokens.a,
      `mutation ($id: ID!) { orderMarkAsPaid(id: $id) { order { financialStatus amountPaid { formatted } paidAt } userErrors { code } } }`,
      { id: order.id },
    );
    expect(paid.order).toMatchObject({
      financialStatus: 'PAID',
      amountPaid: { formatted: 'Rs 9,749' },
      paidAt: expect.any(String),
    });

    const timeline = await gql(
      tokens.aReader,
      `query ($id: ID!) { order(id: $id) { events(first: 2) { nodes { kind message createdAt } pageInfo { hasNextPage } } } }`,
      { id: order.id },
    );
    expect(timeline.data?.order.events).toEqual({
      nodes: [
        {
          kind: 'paid',
          message: 'Marked as paid: Rs 9,749 received',
          createdAt: expect.any(String),
        },
        { kind: 'confirmed', message: 'Confirmed by the customer', createdAt: expect.any(String) },
      ],
      pageInfo: { hasNextPage: true },
    });
  });

  it('cancels an order and releases its stock', async () => {
    const [size] = await stockedVariants(tokens.a, 'Multani Khussa', ['37'], 2);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 2 }], shippingAddress: ADDRESS },
    });
    const soldOut = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 1 }], shippingAddress: ADDRESS },
    });
    expect(soldOut).toEqual({
      order: null,
      userErrors: [
        {
          field: ['input', 'lineItems', '0', 'quantity'],
          code: 'OUT_OF_STOCK',
          message: '"Multani Khussa" is out of stock at Main location',
        },
      ],
    });
    const cancelled = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         orderCancel(id: $id, reason: CUSTOMER, staffNote: "Ordered by mistake") {
           order { stage status cancelReason cancelledAt } userErrors { code }
         }
       }`,
      { id: created.order.id },
    );
    expect(cancelled.order).toMatchObject({
      stage: 'CANCELLED',
      status: 'CANCELLED',
      cancelReason: 'CUSTOMER',
      cancelledAt: expect.any(String),
    });
    const again = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 2 }], shippingAddress: ADDRESS },
    });
    expect(again.userErrors).toEqual([]);
  });

  it('changes the address and returns user errors for bad input', async () => {
    const [size] = await stockedVariants(tokens.a, 'Lawn Suit', ['S'], 10);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 1 }], shippingAddress: ADDRESS },
    });
    const updated = await mutate(
      tokens.a,
      `mutation ($id: ID!, $input: OrderUpdateInput!) {
         orderUpdate(id: $id, input: $input) { order { phone shippingAddress { city province } note version } userErrors { code } }
       }`,
      {
        id: created.order.id,
        input: {
          shippingAddress: { ...ADDRESS, phone: '0321 7654321', city: 'pindi', zip: null },
          note: 'Leave with the guard',
        },
      },
    );
    expect(updated.order).toEqual({
      phone: '+923217654321',
      shippingAddress: { city: 'Rawalpindi', province: 'Punjab' },
      note: 'Leave with the guard',
      version: 2,
    });
    const invalid = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 0 }],
        shippingAddress: { ...ADDRESS, phone: '12345' },
      },
    });
    expect(invalid.userErrors).toEqual([
      {
        field: ['input', 'lineItems', '0', 'quantity'],
        code: 'INVALID',
        message: 'Quantity must be a whole number from 1 to 10000',
      },
      {
        field: ['input', 'shippingAddress', 'phone'],
        code: 'INVALID',
        message: 'Phone must be a Pakistani mobile number, like 0300 1234567',
      },
    ]);
  });

  it("changes an order's items while it waits to be packed (ADR-131)", async () => {
    const [small, medium] = await stockedVariants(tokens.a, 'Bridal Lehnga', ['S', 'M'], 3);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: small, quantity: 1 }],
        shippingAddress: ADDRESS,
        shippingPrice: '250',
      },
    });
    const orderId = created.order.id as string;
    const lines = await gql(tokens.a, 'query ($id: ID!) { order(id: $id) { lineItems { id } } }', {
      id: orderId,
    });
    const lineItemId = lines.data?.order.lineItems[0].id as string;
    const EDIT = `
      mutation ($id: ID!, $input: OrderEditLineItemsInput!) {
        orderEditLineItems(id: $id, input: $input) {
          order {
            lineItems { id variantTitle quantity unitPrice { formatted } }
            subtotalPrice { formatted } totalPrice { formatted } codAmount { formatted } version
            events(first: 1) { nodes { kind message } }
          }
          userErrors { field code message }
        }
      }`;

    const edited = await mutate(tokens.a, EDIT, {
      id: orderId,
      input: {
        setQuantities: [{ lineItemId, quantity: 2 }],
        addVariants: [{ variantId: medium, quantity: 1, price: '2,999' }],
      },
    });
    expect(edited).toEqual({
      order: {
        lineItems: [
          { id: lineItemId, variantTitle: 'S', quantity: 2, unitPrice: { formatted: 'Rs 3,499' } },
          {
            id: expect.stringMatching(/^li_/),
            variantTitle: 'M',
            quantity: 1,
            unitPrice: { formatted: 'Rs 2,999' },
          },
        ],
        subtotalPrice: { formatted: 'Rs 9,997' },
        totalPrice: { formatted: 'Rs 10,247' },
        codAmount: { formatted: 'Rs 10,247' },
        version: 2,
        events: {
          nodes: [
            {
              kind: 'edited',
              message:
                'Changed the items: 2 × Bridal Lehnga (S) instead of 1, added 1 × Bridal Lehnga ' +
                '(M); Rs 10,247 instead of Rs 3,749',
            },
          ],
        },
      },
      userErrors: [],
    });

    // One small is left to sell, so two more are refused.
    const short = await mutate(tokens.a, EDIT, {
      id: orderId,
      input: { setQuantities: [{ lineItemId, quantity: 4 }] },
    });
    expect(short).toEqual({
      order: null,
      userErrors: [
        {
          field: ['input', 'setQuantities', '0', 'quantity'],
          code: 'OUT_OF_STOCK',
          message: 'Only 1 more of "Bridal Lehnga" left at Main location',
        },
      ],
    });
    // Readers can't, nor another shop, and line items are named by their own IDs.
    const reader = await gql(tokens.aReader, EDIT, {
      id: orderId,
      input: { setQuantities: [{ lineItemId, quantity: 1 }] },
    });
    expect(reader.errors?.[0]?.message).toContain('write_orders');
    const elsewhere = await mutate(tokens.b, EDIT, {
      id: orderId,
      input: { setQuantities: [{ lineItemId, quantity: 1 }] },
    });
    expect(elsewhere.userErrors).toEqual([
      { field: ['id'], code: 'NOT_FOUND', message: 'Order not found' },
    ]);
    const malformed = await gql(tokens.a, EDIT, {
      id: orderId,
      input: { setQuantities: [{ lineItemId: orderId, quantity: 1 }] },
    });
    expect(malformed.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it("changes an order's delivery charge and discount (ADR-134)", async () => {
    const [size] = await stockedVariants(tokens.a, 'Ralli Quilt', ['Double'], 3);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 1 }],
        shippingAddress: ADDRESS,
        shippingPrice: '250',
      },
    });
    const CHARGES = `
      mutation ($id: ID!, $input: OrderEditChargesInput!) {
        orderEditCharges(id: $id, input: $input) {
          order { totalShippingPrice { formatted } totalDiscounts { formatted }
                  totalPrice { formatted } codAmount { formatted } }
          userErrors { field code message }
        }
      }`;
    const waived = await mutate(tokens.a, CHARGES, {
      id: created.order.id,
      input: { shippingPrice: '0', discount: '499' },
    });
    expect(waived).toEqual({
      order: {
        totalShippingPrice: { formatted: 'Rs 0' },
        totalDiscounts: { formatted: 'Rs 499' },
        totalPrice: { formatted: 'Rs 3,000' },
        codAmount: { formatted: 'Rs 3,000' },
      },
      userErrors: [],
    });
    const tooMuch = await mutate(tokens.a, CHARGES, {
      id: created.order.id,
      input: { discount: '4,000' },
    });
    expect(tooMuch.userErrors).toEqual([
      {
        field: ['input', 'discount'],
        code: 'INVALID',
        message: 'Its discount of Rs 4,000 would be more than its items cost, Rs 3,499',
      },
    ]);
    const reader = await gql(tokens.aReader, CHARGES, {
      id: created.order.id,
      input: { shippingPrice: '250' },
    });
    expect(reader.errors?.[0]?.message).toContain('write_orders');
  });

  it('merges an order its customer placed twice into the other (ADR-132)', async () => {
    const [size] = await stockedVariants(tokens.a, 'Khaddar Shawl', ['Free'], 5);
    const place = async (quantity: number) =>
      (
        await mutate(tokens.a, ORDER_CREATE, {
          input: {
            lineItems: [{ variantId: size, quantity }],
            shippingAddress: { ...ADDRESS, phone: '0345-1112223' },
            shippingPrice: '250',
          },
        })
      ).order.id as string;
    const first = await place(1);
    const second = await place(2);
    const MERGE = `
      mutation ($id: ID!, $intoId: ID!) {
        orderMerge(id: $id, intoId: $intoId) {
          order { id lineItems { quantity } totalPrice { formatted } }
          mergedOrder { stage cancelReason mergedInto { id name } }
          userErrors { field code message }
        }
      }`;
    const merged = await mutate(tokens.a, MERGE, { id: second, intoId: first });
    expect(merged).toEqual({
      order: { id: first, lineItems: [{ quantity: 3 }], totalPrice: { formatted: 'Rs 10,747' } },
      mergedOrder: {
        stage: 'CANCELLED',
        cancelReason: 'MERGED',
        mergedInto: { id: first, name: expect.stringMatching(/^#\d+$/) },
      },
      userErrors: [],
    });
    const again = await mutate(tokens.a, MERGE, { id: second, intoId: first });
    expect(again.userErrors).toEqual([
      {
        field: ['id'],
        code: 'INVALID',
        message: expect.stringContaining('was merged into another order already'),
      },
    ]);
    // Only merging cancels an order as merged.
    const cancel = await mutate(
      tokens.a,
      'mutation ($id: ID!) { orderCancel(id: $id, reason: MERGED) { userErrors { field code } } }',
      { id: first },
    );
    expect(cancel.userErrors).toEqual([{ field: ['reason'], code: 'INVALID' }]);
    const reader = await gql(tokens.aReader, MERGE, { id: second, intoId: first });
    expect(reader.errors?.[0]?.message).toContain('write_orders');
  });

  it('splits an order in two, the items sent apart an order of their own (ADR-135)', async () => {
    const [size] = await stockedVariants(tokens.a, 'Multani Khussa', ['8'], 4);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 3 }],
        shippingAddress: { ...ADDRESS, phone: '0345-5556667' },
        shippingPrice: '250',
      },
    });
    const orderId = created.order.id as string;
    const lineItemId = (
      await gql(tokens.a, `query ($id: ID!) { order(id: $id) { lineItems { id } } }`, {
        id: orderId,
      })
    ).data?.order.lineItems[0].id as string;
    const SPLIT = `
      mutation ($id: ID!, $input: OrderSplitInput!) {
        orderSplit(id: $id, input: $input) {
          order { id lineItems { quantity } totalPrice { formatted } codAmount { formatted } }
          splitOrder { stage lineItems { quantity } totalShippingPrice { formatted }
                       totalPrice { formatted } codAmount { formatted } splitFrom { id name } }
          userErrors { field code message }
        }
      }`;
    const split = await mutate(tokens.a, SPLIT, {
      id: orderId,
      input: { lineItems: [{ lineItemId, quantity: 1 }], shippingPrice: '150' },
    });
    expect(split).toEqual({
      order: {
        id: orderId,
        lineItems: [{ quantity: 2 }],
        totalPrice: { formatted: 'Rs 7,248' },
        codAmount: { formatted: 'Rs 7,248' },
      },
      splitOrder: {
        stage: 'NEEDS_CONFIRMATION',
        lineItems: [{ quantity: 1 }],
        totalShippingPrice: { formatted: 'Rs 150' },
        totalPrice: { formatted: 'Rs 3,649' },
        codAmount: { formatted: 'Rs 3,649' },
        splitFrom: { id: orderId, name: created.order.name },
      },
      userErrors: [],
    });
    const all = await mutate(tokens.a, SPLIT, {
      id: orderId,
      input: { lineItems: [{ lineItemId, quantity: 2 }] },
    });
    expect(all.userErrors).toEqual([
      {
        field: ['input', 'lineItems'],
        code: 'INVALID',
        message: 'An order keeps at least one item: send apart less than all of it',
      },
    ]);
    const reader = await gql(tokens.aReader, SPLIT, {
      id: orderId,
      input: { lineItems: [{ lineItemId, quantity: 1 }] },
    });
    expect(reader.errors?.[0]?.message).toContain('write_orders');
  });

  it('takes back what a customer returns of a delivered parcel (ADR-136)', async () => {
    const [size] = await stockedVariants(tokens.a, 'Lawn Kurta', ['M'], 3);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 2 }],
        shippingAddress: ADDRESS,
        paymentMethod: 'PREPAID',
      },
    });
    const orderId = created.order.id as string;
    const lineId = (
      await gql(tokens.a, `query ($id: ID!) { order(id: $id) { lineItems { id } } }`, {
        id: orderId,
      })
    ).data?.order.lineItems[0].id as string;
    const parcel = await mutate(
      tokens.a,
      `mutation ($id: ID!) { orderFulfill(id: $id) { fulfillment { id } } }`,
      { id: orderId },
    );
    await mutate(
      tokens.a,
      `mutation ($id: ID!) { fulfillmentMarkDelivered(id: $id) { fulfillment { id } } }`,
      { id: parcel.fulfillment.id },
    );
    const RETURN = `return { id name status note location { name }
                             trackingInfo { company number }
                             returnLineItems { lineItem { id } quantity returnReason restockedQuantity }
                             closedAt cancelledAt }
                    order { returnStatus returns { name } }
                    userErrors { field code message }`;
    const CREATE = `mutation ($input: ReturnCreateInput!) { returnCreate(input: $input) { ${RETURN} } }`;
    const created1 = await mutate(tokens.a, CREATE, {
      input: {
        orderId,
        returnLineItems: [{ lineItemId: lineId, quantity: 1, returnReason: 'SIZE_TOO_SMALL' }],
        trackingInfo: { company: 'Leopards', number: 'LP 4455' },
        note: 'Wants L',
      },
    });
    expect(created1).toEqual({
      return: {
        id: expect.stringMatching(/^ret_/),
        name: `${created.order.name}-R1`,
        status: 'OPEN',
        note: 'Wants L',
        location: { name: 'Main location' },
        trackingInfo: { company: 'Leopards', number: 'LP 4455' },
        returnLineItems: [
          {
            lineItem: { id: lineId },
            quantity: 1,
            returnReason: 'SIZE_TOO_SMALL',
            restockedQuantity: null,
          },
        ],
        closedAt: null,
        cancelledAt: null,
      },
      order: { returnStatus: 'IN_PROGRESS', returns: [{ name: `${created.order.name}-R1` }] },
      userErrors: [],
    });
    // On its way, it is listed to chase and counted on the home (ADR-138).
    const open = await gql(
      tokens.a,
      `{ openReturns(first: 50) { nodes { name days units trackingInfo { company number } } }
         home { returnsToReceive { count } } }`,
    );
    expect(open.data?.openReturns.nodes).toContainEqual({
      name: `${created.order.name}-R1`,
      days: 0,
      units: 1,
      trackingInfo: { company: 'Leopards', number: 'LP 4455' },
    });
    expect(open.data?.home.returnsToReceive.count).toBeGreaterThanOrEqual(1);
    const tooMany = await mutate(tokens.a, CREATE, {
      input: {
        orderId,
        returnLineItems: [{ lineItemId: lineId, quantity: 2, returnReason: 'UNWANTED' }],
      },
    });
    expect(tooMany.userErrors).toEqual([
      {
        field: ['input', 'returnLineItems', '0', 'quantity'],
        code: 'INVALID',
        message: 'Only 1 of "Lawn Kurta (M)" delivered can come back',
      },
    ]);
    const received = await mutate(
      tokens.a,
      `mutation ($id: ID!) { returnReceive(id: $id) { ${RETURN} } }`,
      { id: created1.return.id },
    );
    expect(received.return).toMatchObject({
      status: 'CLOSED',
      returnLineItems: [{ restockedQuantity: 1 }],
      closedAt: expect.any(String),
    });
    expect(received.order.returnStatus).toBe('RETURNED');
    const cancelled = await mutate(
      tokens.a,
      `mutation ($id: ID!) { returnCancel(id: $id) { ${RETURN} } }`,
      { id: created1.return.id },
    );
    expect(cancelled.userErrors).toEqual([
      { field: ['id'], code: 'INVALID', message: 'The return was checked in already' },
    ]);
    // The other kurta comes back too, for another of the same sent at once (ADR-137): what was
    // paid for it pays for the exchange, by a refund in which no money moves.
    const exchanged = await mutate(
      tokens.a,
      `mutation ($input: ReturnCreateInput!) {
         returnCreate(input: $input) {
           return { name exchangeOrder { id name } }
           order { refunds { amount { formatted } method reference } }
           userErrors { field code message }
         }
       }`,
      {
        input: {
          orderId,
          returnLineItems: [{ lineItemId: lineId, quantity: 1, returnReason: 'DEFECTIVE' }],
          exchangeLineItems: [{ variantId: size, quantity: 1 }],
        },
      },
    );
    expect(exchanged.userErrors).toEqual([]);
    expect(exchanged.return.name).toBe(`${created.order.name}-R2`);
    expect(exchanged.order.refunds).toEqual([
      {
        amount: { formatted: 'Rs 3,499' },
        method: 'EXCHANGE',
        reference: exchanged.return.exchangeOrder.name,
      },
    ]);
    const sent = await gql(
      tokens.a,
      `query ($id: ID!) { order(id: $id) { confirmationStatus amountPaid { formatted }
                                          codAmount { formatted } lineItems { quantity } } }`,
      { id: exchanged.return.exchangeOrder.id },
    );
    expect(sent.data?.order).toEqual({
      confirmationStatus: 'CONFIRMED',
      amountPaid: { formatted: 'Rs 3,499' },
      codAmount: { formatted: 'Rs 0' },
      lineItems: [{ quantity: 1 }],
    });
    const reader = await gql(tokens.aReader, CREATE, {
      input: {
        orderId,
        returnLineItems: [{ lineItemId: lineId, quantity: 1, returnReason: 'OTHER' }],
      },
    });
    expect(reader.errors?.[0]?.message).toContain('write_orders');
  });

  it('ships an order, follows its parcels and checks a refused one back in', async () => {
    const [size] = await stockedVariants(tokens.a, 'Sindhi Ajrak', ['One size'], 4);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 2 }],
        shippingAddress: ADDRESS,
        paymentMethod: 'PREPAID',
      },
    });
    const orderId = created.order.id;
    const lineId = (
      await gql(tokens.a, `query ($id: ID!) { order(id: $id) { lineItems { id } } }`, {
        id: orderId,
      })
    ).data?.order.lineItems[0].id as string;

    const PARCEL = `fulfillment { id status trackingInfo { company number url } location { name }
                      fulfillmentLineItems { lineItem { id } quantity restockedQuantity }
                      shippedAt deliveredAt returnedAt }
                    order { stage status fulfillmentStatus financialStatus
                            lineItems { fulfilledQuantity fulfillableQuantity } }
                    userErrors { field code message }`;
    const first = await mutate(
      tokens.a,
      `mutation ($id: ID!, $input: OrderFulfillInput) { orderFulfill(id: $id, input: $input) { ${PARCEL} } }`,
      {
        id: orderId,
        input: {
          lineItems: [{ id: lineId, quantity: 1 }],
          trackingInfo: { company: 'TCS', number: '779012345678' },
        },
      },
    );
    expect(first).toEqual({
      fulfillment: {
        id: expect.stringMatching(/^ful_/),
        status: 'IN_TRANSIT',
        trackingInfo: { company: 'TCS', number: '779012345678', url: null },
        location: { name: 'Main location' },
        fulfillmentLineItems: [{ lineItem: { id: lineId }, quantity: 1, restockedQuantity: null }],
        shippedAt: expect.any(String),
        deliveredAt: null,
        returnedAt: null,
      },
      order: {
        stage: 'PARTIALLY_FULFILLED',
        status: 'OPEN',
        fulfillmentStatus: 'PARTIALLY_FULFILLED',
        financialStatus: 'PAID',
        lineItems: [{ fulfilledQuantity: 1, fulfillableQuantity: 1 }],
      },
      userErrors: [],
    });
    const second = await mutate(
      tokens.a,
      `mutation ($id: ID!) { orderFulfill(id: $id) { ${PARCEL} } }`,
      { id: orderId },
    );
    expect(second.order.stage).toBe('IN_TRANSIT');

    const delivered = await mutate(
      tokens.a,
      `mutation ($id: ID!) { fulfillmentMarkDelivered(id: $id) { ${PARCEL} } }`,
      { id: first.fulfillment.id },
    );
    expect(delivered.fulfillment).toMatchObject({
      status: 'DELIVERED',
      deliveredAt: expect.any(String),
    });
    const returning = await mutate(
      tokens.a,
      `mutation ($id: ID!) { fulfillmentMarkReturning(id: $id) { ${PARCEL} } }`,
      { id: second.fulfillment.id },
    );
    expect(returning.order.stage).toBe('RETURNING');
    const back = await mutate(
      tokens.a,
      `mutation ($id: ID!, $restock: [FulfillmentRestockInput!]) {
         fulfillmentReceiveReturn(id: $id, restock: $restock) { ${PARCEL} }
       }`,
      { id: second.fulfillment.id, restock: [{ lineItemId: lineId, quantity: 0 }] },
    );
    expect(back.fulfillment).toMatchObject({
      status: 'RETURNED',
      fulfillmentLineItems: [{ quantity: 1, restockedQuantity: 0 }],
      returnedAt: expect.any(String),
    });
    // Prepaid, one parcel delivered: done.
    expect(back.order).toMatchObject({
      stage: 'COMPLETED',
      status: 'CLOSED',
      fulfillmentStatus: 'PARTIALLY_RETURNED',
      lineItems: [{ fulfilledQuantity: 2, fulfillableQuantity: 0 }],
    });

    const tracked = await gql(
      tokens.aReader,
      '{ orders(first: 5, query: "779012345678") { nodes { id } } }',
    );
    expect(tracked.data?.orders.nodes).toEqual([{ id: orderId }]);
    const tracking = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         fulfillmentTrackingInfoUpdate(id: $id, trackingInfo: { company: "TCS", number: "779012345679", url: "https://www.tcsexpress.com/track" }) { ${PARCEL} }
       }`,
      { id: first.fulfillment.id },
    );
    expect(tracking.fulfillment.trackingInfo).toEqual({
      company: 'TCS',
      number: '779012345679',
      url: 'https://www.tcsexpress.com/track',
    });
    for (const [name, query] of [
      [
        'orderFulfill',
        `mutation ($id: ID!) { orderFulfill(id: $id) { userErrors { field code } } }`,
      ],
      [
        'fulfillmentMarkDelivered',
        `mutation ($id: ID!) { fulfillmentMarkDelivered(id: $id) { userErrors { field code } } }`,
      ],
      [
        'fulfillmentMarkReturning',
        `mutation ($id: ID!) { fulfillmentMarkReturning(id: $id) { userErrors { field code } } }`,
      ],
      [
        'fulfillmentReceiveReturn',
        `mutation ($id: ID!) { fulfillmentReceiveReturn(id: $id) { userErrors { field code } } }`,
      ],
      [
        'fulfillmentTrackingInfoUpdate',
        `mutation ($id: ID!) { fulfillmentTrackingInfoUpdate(id: $id, trackingInfo: { number: "X" }) { userErrors { field code } } }`,
      ],
    ] as const) {
      const id = name === 'orderFulfill' ? orderId : first.fulfillment.id;
      const payload = await mutate(tokens.b, query, { id });
      expect(payload.userErrors, name).toEqual([{ field: ['id'], code: 'NOT_FOUND' }]);
    }
  });

  it("records the steps of a parcel's way that its courier tells of, and lists them (ADR-160)", async () => {
    const [size] = await stockedVariants(tokens.a, 'Khaddar Shawl', ['One size'], 2);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 1 }],
        shippingAddress: ADDRESS,
        paymentMethod: 'PREPAID',
      },
    });
    const orderId = created.order.id;
    const shipped = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         orderFulfill(id: $id, input: { trackingInfo: { company: "Trax", number: "TRX-1" } }) {
           fulfillment { id }
         }
       }`,
      { id: orderId },
    );
    const parcelId = shipped.fulfillment.id as string;
    const CREATE = `mutation ($input: FulfillmentEventInput!) {
      fulfillmentEventCreate(fulfillmentEvent: $input) {
        fulfillmentEvent { id status message happenedAt }
        userErrors { field code }
      }
    }`;
    const happenedAt = new Date(Date.now() - 3_600_000).toISOString();
    expect(
      await mutate(tokens.a, CREATE, {
        input: {
          fulfillmentId: parcelId,
          status: 'IN_TRANSIT',
          message: 'At the Lahore hub',
          happenedAt,
        },
      }),
    ).toEqual({
      fulfillmentEvent: {
        id: expect.stringMatching(/^fev_/),
        status: 'IN_TRANSIT',
        message: 'At the Lahore hub',
        happenedAt,
      },
      userErrors: [],
    });
    expect(
      (
        await mutate(tokens.a, CREATE, {
          input: { fulfillmentId: parcelId, status: 'OUT_FOR_DELIVERY' },
        })
      ).userErrors,
    ).toEqual([]);
    // Its delivery is fulfillmentMarkDelivered's; another shop's parcel is not found.
    expect(
      await mutate(tokens.a, CREATE, { input: { fulfillmentId: parcelId, status: 'DELIVERED' } }),
    ).toEqual({
      fulfillmentEvent: null,
      userErrors: [{ field: ['fulfillmentEvent', 'status'], code: 'INVALID' }],
    });
    expect(
      (await mutate(tokens.b, CREATE, { input: { fulfillmentId: parcelId, status: 'IN_TRANSIT' } }))
        .userErrors,
    ).toEqual([{ field: ['fulfillmentEvent', 'fulfillmentId'], code: 'NOT_FOUND' }]);

    // Its steps, in the order they happened, a page at a time; or the latest first.
    const EVENTS = `query ($id: ID!, $after: String, $reverse: Boolean) {
      order(id: $id) {
        fulfillments {
          events(first: 1, after: $after, reverse: $reverse) {
            nodes { status message }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`;
    const eventsOf = async (variables: Record<string, unknown>) => {
      const body = await gql(tokens.aReader, EVENTS, { id: orderId, ...variables });
      expect(body.errors).toBeUndefined();
      return body.data?.order.fulfillments[0].events;
    };
    const firstPage = await eventsOf({});
    expect(firstPage).toEqual({
      nodes: [{ status: 'IN_TRANSIT', message: 'At the Lahore hub' }],
      pageInfo: { hasNextPage: true, endCursor: expect.any(String) },
    });
    expect(await eventsOf({ after: firstPage.pageInfo.endCursor })).toEqual({
      nodes: [{ status: 'OUT_FOR_DELIVERY', message: null }],
      pageInfo: { hasNextPage: false, endCursor: expect.any(String) },
    });
    expect((await eventsOf({ reverse: true })).nodes).toEqual([
      { status: 'OUT_FOR_DELIVERY', message: null },
    ]);
  });

  it('checks parcels in by the tracking numbers on their labels, and lists those coming back', async () => {
    const [size] = await stockedVariants(tokens.a, 'Ralli Quilt', ['One size'], 4);
    const shipped: { orderId: string; parcelId: string }[] = [];
    for (const number of ['LE 5501', 'LE 5502']) {
      // A customer of their own: a refused parcel counts against whoever refused it.
      const created = await mutate(tokens.a, ORDER_CREATE, {
        input: {
          lineItems: [{ variantId: size, quantity: 1 }],
          shippingAddress: { ...ADDRESS, name: 'Bilal Ahmed', phone: '0345 1112233' },
          paymentMethod: 'PREPAID',
        },
      });
      const parcel = await mutate(
        tokens.a,
        `mutation ($id: ID!, $number: String!) {
           orderFulfill(id: $id, input: { trackingInfo: { company: "Leopards", number: $number } }) {
             fulfillment { id }
           }
         }`,
        { id: created.order.id, number },
      );
      await mutate(
        tokens.a,
        `mutation ($id: ID!) { fulfillmentMarkReturning(id: $id) { userErrors { code } } }`,
        { id: parcel.fulfillment.id },
      );
      shipped.push({ orderId: created.order.id, parcelId: parcel.fulfillment.id });
    }
    const RETURNING = `{
      returningParcels(first: 5, courier: "LEOPARDS") {
        nodes { id orderId orderName trackingInfo { company number } days units }
        pageInfo { hasNextPage }
      }
    }`;
    const listed = await gql(tokens.aReader, RETURNING);
    expect(listed.data?.returningParcels).toEqual({
      nodes: shipped.map((parcel, index) => ({
        id: parcel.parcelId,
        orderId: parcel.orderId,
        orderName: expect.stringMatching(/^#\d+$/),
        trackingInfo: { company: 'Leopards', number: `LE 550${index + 1}` },
        days: 0,
        units: 1,
      })),
      pageInfo: { hasNextPage: false },
    });
    // A page at a time: the page after one starts exactly after it, though the database keeps
    // when each started back to the microsecond.
    const PAGE = `query ($after: String) {
      returningParcels(first: 1, courier: "leopards", after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const page = (await gql(tokens.aReader, PAGE)).data?.returningParcels;
    const after = (await gql(tokens.aReader, PAGE, { after: page.pageInfo.endCursor })).data
      ?.returningParcels;
    expect([page.nodes, page.pageInfo.hasNextPage]).toEqual([[{ id: shipped[0]!.parcelId }], true]);
    expect([after.nodes, after.pageInfo.hasNextPage]).toEqual([
      [{ id: shipped[1]!.parcelId }],
      false,
    ]);
    // A cursor's time is to the microsecond, and a day there is: any other is refused.
    const { id } = JSON.parse(Buffer.from(page.pageInfo.endCursor, 'base64url').toString());
    for (const at of ['2026-02-31T09:00:00.123456Z', '2026-10-01T09:00:00.123Z']) {
      const forged = Buffer.from(JSON.stringify({ id, at })).toString('base64url');
      const refused = await gql(tokens.aReader, PAGE, { after: forged });
      expect(refused.errors?.[0]?.extensions?.code, at).toBe('BAD_USER_INPUT');
    }

    // Scanned off its label, without the space.
    const RECEIVE = `mutation ($id: ID, $trackingNumber: String) {
      fulfillmentReceiveReturn(id: $id, trackingNumber: $trackingNumber) {
        fulfillment { id status } order { stage } userErrors { field code message }
      }
    }`;
    expect(await mutate(tokens.a, RECEIVE, { trackingNumber: 'le5501' })).toEqual({
      fulfillment: { id: shipped[0]!.parcelId, status: 'RETURNED' },
      order: { stage: 'RETURNED' },
      userErrors: [],
    });
    const left = await gql(tokens.aReader, RETURNING);
    expect(left.data?.returningParcels.nodes.map((node: Json) => node.id)).toEqual([
      shipped[1]!.parcelId,
    ]);
    // The ID or the tracking number: not both, nor neither.
    for (const variables of [{}, { id: shipped[1]!.parcelId, trackingNumber: 'LE5502' }]) {
      expect((await mutate(tokens.a, RECEIVE, variables)).userErrors).toEqual([
        { field: ['id'], code: 'INVALID', message: "Give the parcel's ID or its tracking number" },
      ]);
    }
    expect((await mutate(tokens.b, RECEIVE, { trackingNumber: 'LE5502' })).userErrors).toEqual([
      {
        field: ['trackingNumber'],
        code: 'NOT_FOUND',
        message: 'No parcel has this tracking number',
      },
    ]);
    // Reading parcels is not checking them in.
    const denied = await gql(tokens.aReader, RECEIVE, { trackingNumber: 'LE5502' });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    // The other the courier lost: written off, its order lost, and no longer coming back. It was
    // prepaid: what the customer is owed is the shop's to settle.
    const lost = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         fulfillmentMarkLost(id: $id) {
           fulfillment { status lostAt } order { stage status financialStatus } userErrors { code }
         }
       }`,
      { id: shipped[1]!.parcelId },
    );
    expect(lost).toEqual({
      fulfillment: { status: 'LOST', lostAt: expect.any(String) },
      order: { stage: 'LOST', status: 'CLOSED', financialStatus: 'PAID' },
      userErrors: [],
    });
    expect((await gql(tokens.aReader, RETURNING)).data?.returningParcels.nodes).toEqual([]);
    // The customer refused both: the one the courier lost on its way back is still a refusal.
    const customers = await issueToken(shopA, ['read_orders', 'read_customers']);
    const history = await gql(
      customers,
      `query ($id: ID!) {
         order(id: $id) { customer { deliveryHistory { returned lost inProgress } } }
       }`,
      { id: shipped[1]!.orderId },
    );
    expect(history.data?.order.customer.deliveryHistory).toEqual({
      returned: 2,
      lost: 0,
      inProgress: 0,
    });
  });

  it('claims what the courier lost, and lists the lost parcels with their claims', async () => {
    const HOME = '{ home { lostToClaim { count } claimsOpen { count } } }';
    const before = (await gql(tokens.aReader, HOME)).data?.home;
    const [size] = await stockedVariants(tokens.a, 'Sindhi Ajrak', ['One size'], 4);
    const lost: { orderId: string; parcelId: string }[] = [];
    for (const number of ['TCS 8801', 'TCS 8802']) {
      const created = await mutate(tokens.a, ORDER_CREATE, {
        input: {
          lineItems: [{ variantId: size, quantity: 1 }],
          shippingAddress: { ...ADDRESS, name: 'Hina Malik', phone: '0333 4445566' },
        },
      });
      await mutate(
        tokens.a,
        `mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { code } } }`,
        { id: created.order.id },
      );
      const parcel = await mutate(
        tokens.a,
        `mutation ($id: ID!, $number: String!) {
           orderFulfill(id: $id, input: { trackingInfo: { company: "TCS", number: $number } }) {
             fulfillment { id }
           }
         }`,
        { id: created.order.id, number },
      );
      await mutate(
        tokens.a,
        `mutation ($id: ID!) { fulfillmentMarkLost(id: $id) { userErrors { code } } }`,
        { id: parcel.fulfillment.id },
      );
      lost.push({ orderId: created.order.id, parcelId: parcel.fulfillment.id });
    }
    const CLAIM = `mutation ($id: ID!, $amount: String, $note: String) {
      fulfillmentClaimCreate(id: $id, amount: $amount, note: $note) {
        fulfillment {
          id claim { status amount { formatted } paid { formatted } note claimedAt settledAt }
        }
        order { id }
        userErrors { field code message }
      }
    }`;
    expect(
      await mutate(tokens.a, CLAIM, { id: lost[0]!.parcelId, note: 'Complaint 4471' }),
    ).toEqual({
      fulfillment: {
        id: lost[0]!.parcelId,
        claim: {
          status: 'OPEN',
          amount: { formatted: 'Rs 3,499' },
          paid: null,
          note: 'Complaint 4471',
          claimedAt: expect.any(String),
          settledAt: null,
        },
      },
      order: { id: lost[0]!.orderId },
      userErrors: [],
    });
    expect((await mutate(tokens.a, CLAIM, { id: lost[0]!.parcelId })).userErrors).toEqual([
      { field: ['id'], code: 'TAKEN', message: 'The parcel is claimed already' },
    ]);
    const SETTLE = `mutation ($id: ID!, $status: FulfillmentClaimSettlement!, $amount: String) {
      fulfillmentClaimSettle(id: $id, status: $status, amount: $amount) {
        fulfillment { claim { status paid { formatted } } }
        userErrors { field code message }
      }
    }`;
    expect(
      await mutate(tokens.a, SETTLE, { id: lost[0]!.parcelId, status: 'PAID', amount: '3000' }),
    ).toEqual({
      fulfillment: { claim: { status: 'PAID', paid: { formatted: 'Rs 3,000' } } },
      userErrors: [],
    });

    const LOST = `{
      lostParcels(first: 5, courier: "tcs", claim: [UNCLAIMED, PAID]) {
        nodes {
          id orderId orderName trackingInfo { company number } days units worth { formatted }
          claim { status }
        }
        pageInfo { hasNextPage }
      }
    }`;
    const listed = await gql(tokens.aReader, LOST);
    expect(listed.errors).toBeUndefined();
    expect(listed.data).toEqual({
      lostParcels: {
        nodes: lost.map((parcel, index) => ({
          id: parcel.parcelId,
          orderId: parcel.orderId,
          orderName: expect.stringMatching(/^#\d+$/),
          trackingInfo: { company: 'TCS', number: `TCS 880${index + 1}` },
          days: 0,
          units: 1,
          worth: { formatted: 'Rs 3,499' },
          claim: index === 0 ? { status: 'PAID' } : null,
        })),
        pageInfo: { hasNextPage: false },
      },
    });
    // The home counts the one still to claim.
    expect((await gql(tokens.aReader, HOME)).data?.home).toEqual({
      lostToClaim: { count: before.lostToClaim.count + 1 },
      claimsOpen: { count: before.claimsOpen.count },
    });
    // Reading lost parcels is not claiming them; nor sees another shop's.
    const denied = await gql(tokens.aReader, CLAIM, { id: lost[1]!.parcelId });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect((await mutate(tokens.b, CLAIM, { id: lost[1]!.parcelId })).userErrors).toEqual([
      { field: ['id'], code: 'NOT_FOUND', message: 'Fulfillment not found' },
    ]);
    expect((await gql(tokens.b, LOST)).data?.lostParcels.nodes).toEqual([]);
  });

  it('claims what came back damaged, and lists every claim to follow up', async () => {
    const [size] = await stockedVariants(tokens.a, 'Multani Khussa', ['37'], 4);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 2 }],
        shippingAddress: { ...ADDRESS, name: 'Sana Iqbal', phone: '0345 1112233' },
      },
    });
    await mutate(
      tokens.a,
      `mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { code } } }`,
      { id: created.order.id },
    );
    const shipped = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         orderFulfill(id: $id, input: { trackingInfo: { company: "PostEx", number: "PX-77" } }) {
           fulfillment { id fulfillmentLineItems { lineItem { id } } }
         }
       }`,
      { id: created.order.id },
    );
    const id = shipped.fulfillment.id as string;
    const lineItemId = shipped.fulfillment.fulfillmentLineItems[0].lineItem.id as string;
    await mutate(
      tokens.a,
      `mutation ($id: ID!) { fulfillmentMarkReturning(id: $id) { userErrors { code } } }`,
      { id },
    );
    // Back with one of the two written off as damaged: its Rs 3,499 is claimed.
    await mutate(
      tokens.a,
      `mutation ($id: ID!, $restock: [FulfillmentRestockInput!]) {
         fulfillmentReceiveReturn(id: $id, restock: $restock) { userErrors { code } }
       }`,
      { id, restock: [{ lineItemId, quantity: 1 }] },
    );
    const claimed = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         fulfillmentClaimCreate(id: $id) {
           fulfillment { claim { status amount { formatted } } } userErrors { code }
         }
       }`,
      { id },
    );
    expect(claimed).toEqual({
      fulfillment: { claim: { status: 'OPEN', amount: { formatted: 'Rs 3,499' } } },
      userErrors: [],
    });
    const CLAIMS = `{
      parcelClaims(first: 5, courier: "postex", status: [OPEN]) {
        nodes { id orderId status trackingInfo { number } claim { amount { formatted } } }
        pageInfo { hasNextPage }
      }
    }`;
    expect((await gql(tokens.aReader, CLAIMS)).data).toEqual({
      parcelClaims: {
        nodes: [
          {
            id,
            orderId: created.order.id,
            status: 'RETURNED',
            trackingInfo: { number: 'PX-77' },
            claim: { amount: { formatted: 'Rs 3,499' } },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    expect((await gql(tokens.b, CLAIMS)).data?.parcelClaims.nodes).toEqual([]);
  });

  it('needs order scopes, and rejects malformed ids', async () => {
    const write = await gql(
      tokens.aReader,
      `mutation { orderConfirm(id: "ord_${'0'.repeat(26)}") { userErrors { code } } }`,
    );
    expect(write.errors?.[0]?.message).toContain('write_orders');
    const read = await gql(tokens.aNoOrders, '{ orders(first: 1) { nodes { id } } }');
    expect(read.errors?.[0]?.message).toContain('read_orders');
    const malformed = await gql(tokens.a, `{ order(id: "prod_${'0'.repeat(26)}") { id } }`);
    expect(malformed.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    const cursor = await gql(
      tokens.a,
      '{ orders(first: 1, after: "bm90LWpzb24") { nodes { id } } }',
    );
    expect(cursor.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it("never exposes or changes another shop's orders", async () => {
    const [size] = await stockedVariants(tokens.a, 'Private Kurta', ['M'], 3);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 1 }], shippingAddress: ADDRESS },
    });
    const orderId = created.order.id;
    const read = await gql(tokens.b, `query ($id: ID!) { order(id: $id) { id } }`, { id: orderId });
    expect(read).toEqual({ data: { order: null } });
    const list = await gql(tokens.b, '{ orders(first: 10) { nodes { id } } }');
    expect(list.data?.orders.nodes).toEqual([]);

    for (const [name, query] of [
      [
        'orderConfirm',
        `mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { field code } } }`,
      ],
      [
        'orderCancel',
        `mutation ($id: ID!) { orderCancel(id: $id, reason: FRAUD) { userErrors { field code } } }`,
      ],
      [
        'orderMarkAsPaid',
        `mutation ($id: ID!) { orderMarkAsPaid(id: $id) { userErrors { field code } } }`,
      ],
      [
        'orderUpdate',
        `mutation ($id: ID!) { orderUpdate(id: $id, input: { note: "Mine" }) { userErrors { field code } } }`,
      ],
    ] as const) {
      const payload = await mutate(tokens.b, query, { id: orderId });
      expect(payload.userErrors, name).toEqual([{ field: ['id'], code: 'NOT_FOUND' }]);
    }
    const stolen = await mutate(tokens.b, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 1 }], shippingAddress: ADDRESS },
    });
    expect(stolen.userErrors).toMatchObject([
      { field: ['input', 'lineItems', '0', 'variantId'], code: 'NOT_FOUND' },
    ]);
    const own = await gql(tokens.a, `query ($id: ID!) { order(id: $id) { stage note version } }`, {
      id: orderId,
    });
    expect(own.data?.order).toEqual({ stage: 'NEEDS_CONFIRMATION', note: '', version: 1 });
  });

  it('scores cash-on-delivery orders and holds risky ones, as the shop sets', async () => {
    const SETTINGS = '{ orderRiskSettings { holdAt highValue { amount formatted } updatedAt } }';
    const UPDATE = `
      mutation ($input: OrderRiskSettingsInput!) {
        orderRiskSettingsUpdate(input: $input) {
          riskSettings { holdAt highValue { formatted } }
          userErrors { field code message }
        }
      }`;
    // Owners and managers set the policy; order scopes are not enough.
    expect((await gql(tokens.a, SETTINGS)).errors?.[0]?.message).toContain('read_settings');
    const denied = await gql(tokens.a, UPDATE, { input: { holdAt: 0.3 } });
    expect(denied.errors?.[0]?.message).toContain('write_settings');

    const settings = await issueToken(shopA, ['write_settings']);
    expect((await gql(settings, SETTINGS)).data?.orderRiskSettings).toEqual({
      holdAt: 0.6,
      highValue: { amount: '15000.00', formatted: 'Rs 15,000' },
      updatedAt: null,
    });
    expect(await mutate(settings, UPDATE, { input: { holdAt: 2 } })).toEqual({
      riskSettings: null,
      userErrors: [
        {
          field: ['input', 'holdAt'],
          code: 'INVALID',
          message: 'Hold at must be from 0.01 to 1, in hundredths',
        },
      ],
    });
    expect(await mutate(settings, UPDATE, { input: { holdAt: 0.3, highValue: '5,000' } })).toEqual({
      riskSettings: { holdAt: 0.3, highValue: { formatted: 'Rs 5,000' } },
      userErrors: [],
    });

    // A first order worth Rs 6,998 from a new number scores 0.3: held.
    const [size] = await stockedVariants(tokens.a, 'Bridal Dupatta', ['Free'], 5);
    const held = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 2 }],
        shippingAddress: { ...ADDRESS, phone: '0345-7654321' },
      },
    });
    expect(held.order).toMatchObject({
      stage: 'NEEDS_REVIEW',
      confirmationStatus: 'NEEDS_REVIEW',
      risk: {
        score: 0.3,
        level: 'MEDIUM',
        reasons: [
          { code: 'high_value', message: 'High value: Rs 6,998', weight: 0.2 },
          { code: 'first_order', message: 'First order from this number', weight: 0.1 },
        ],
      },
    });
    const medium = await gql(
      tokens.aReader,
      '{ orders(first: 50, riskLevel: MEDIUM) { nodes { id risk { level } } } }',
    );
    const nodes = medium.data?.orders.nodes as { id: string; risk: { level: string } }[];
    expect(nodes.map((node) => node.id)).toContain(held.order.id);
    expect(new Set(nodes.map((node) => node.risk.level))).toEqual(new Set(['MEDIUM']));

    await mutate(settings, UPDATE, { input: { holdAt: 0.6, highValue: '15000' } });
  });

  it('packs orders, and confirms, packs, tags and cancels many at once', async () => {
    const [size] = await stockedVariants(tokens.a, 'Khaddar Shawl', ['Free'], 10);
    const ids: string[] = [];
    for (const name of ['Ayesha Khan', 'Bilal Ahmed', 'Sana Tariq']) {
      const created = await mutate(tokens.a, ORDER_CREATE, {
        input: {
          lineItems: [{ variantId: size, quantity: 1 }],
          shippingAddress: { ...ADDRESS, name },
        },
      });
      ids.push(created.order.id as string);
    }
    const [first, second, third] = ids as [string, string, string];
    const PACK = `
      mutation ($id: ID!) {
        orderMarkPacked(id: $id) { order { stage packedAt } userErrors { field code message } }
      }`;
    expect(await mutate(tokens.a, PACK, { id: first })).toEqual({
      order: null,
      userErrors: [
        { field: ['id'], code: 'INVALID', message: 'Only confirmed or paid orders can be packed' },
      ],
    });

    const bulk = (name: string, args = '') => `
      mutation ($ids: [ID!]!) {
        ${name}(ids: $ids${args}) {
          orders { id stage tags } userErrors { field code message }
        }
      }`;
    const stages = (payload: Json) => payload.orders.map((order: Json) => order.stage) as string[];
    const missing = `ord_${'0'.repeat(26)}`;
    const confirmed = await mutate(tokens.a, bulk('orderBulkConfirm'), { ids: [...ids, missing] });
    expect(stages(confirmed)).toEqual(['TO_PACK', 'TO_PACK', 'TO_PACK']);
    expect(confirmed.userErrors).toEqual([
      { field: ['ids', '3'], code: 'NOT_FOUND', message: 'Order not found' },
    ]);

    expect(await mutate(tokens.a, PACK, { id: first })).toEqual({
      order: { stage: 'TO_BOOK', packedAt: expect.any(String) },
      userErrors: [],
    });
    const packed = await mutate(tokens.a, bulk('orderBulkMarkPacked'), { ids: [second, third] });
    expect(stages(packed)).toEqual(['TO_BOOK', 'TO_BOOK']);
    const toBook = await gql(
      tokens.aReader,
      '{ orders(first: 50, stage: TO_BOOK) { nodes { id } } }',
    );
    expect(toBook.data?.orders.nodes.map((node: Json) => node.id)).toEqual([third, second, first]);
    const unpacked = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         orderMarkUnpacked(id: $id) { order { stage packedAt } userErrors { code } }
       }`,
      { id: third },
    );
    expect(unpacked).toEqual({ order: { stage: 'TO_PACK', packedAt: null }, userErrors: [] });

    const tagged = await mutate(tokens.a, bulk('orderBulkAddTags', ', tags: ["eid", "tcs"]'), {
      ids,
    });
    expect(tagged.orders.map((order: Json) => order.tags)).toEqual([
      ['eid', 'tcs'],
      ['eid', 'tcs'],
      ['eid', 'tcs'],
    ]);
    const untagged = await mutate(tokens.a, bulk('orderBulkRemoveTags', ', tags: ["EID"]'), {
      ids: [first],
    });
    expect(untagged.orders[0].tags).toEqual(['tcs']);

    // Another shop's orders are not found, and stay as they are.
    const elsewhere = await mutate(tokens.b, bulk('orderBulkCancel', ', reason: FRAUD'), { ids });
    expect(elsewhere).toEqual({
      orders: [],
      userErrors: ids.map((_, index) => ({
        field: ['ids', String(index)],
        code: 'NOT_FOUND',
        message: 'Order not found',
      })),
    });
    const cancelled = await mutate(
      tokens.a,
      bulk('orderBulkCancel', ', reason: NO_RESPONSE, staffNote: "Unreachable for two days"'),
      { ids },
    );
    expect(stages(cancelled)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);

    expect((await mutate(tokens.a, bulk('orderBulkConfirm'), { ids: [] })).userErrors).toEqual([
      { field: ['ids'], code: 'BLANK', message: 'Ids must include at least one' },
    ]);
    const denied = await gql(tokens.aReader, bulk('orderBulkConfirm'), { ids });
    expect(denied.errors?.[0]?.message).toContain('write_orders');
  });

  it('prints packing slips and invoices for the orders asked for', async () => {
    const [size] = await stockedVariants(tokens.a, 'Kohati Chappal', ['9'], 5);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 2 }], shippingAddress: ADDRESS },
    });
    const id = created.order.id as string;
    const DOCUMENT = `
      query ($ids: [ID!]!, $kind: OrderDocumentKind!, $paper: PaperSize, $language: DocumentLanguage) {
        orderDocument(ids: $ids, kind: $kind, paper: $paper, language: $language) {
          html title fileName orders { id name }
        }
      }`;
    const slip = await gql(tokens.aReader, DOCUMENT, { ids: [id], kind: 'PACKING_SLIP' });
    const document = slip.data?.orderDocument;
    expect(document).toMatchObject({
      title: `Packing slip ${created.order.name}`,
      fileName: `packing-slip-${created.order.number}.html`,
      orders: [{ id, name: created.order.name }],
    });
    // A4 and both languages unless asked otherwise.
    expect(document.html).toMatch(/<html\s+lang="en"\s+dir="ltr"\s+data-paper="a4"/);
    expect(document.html).toContain('<span lang="ur" dir="rtl">پیکنگ سلپ</span>');
    expect(document.html).toContain('Rs 6,998');

    const invoice = await gql(tokens.a, DOCUMENT, {
      ids: [id],
      kind: 'INVOICE',
      paper: 'THERMAL_80MM',
      language: 'URDU',
    });
    expect(invoice.data?.orderDocument.html).toMatch(
      /<html\s+lang="ur"\s+dir="rtl"\s+data-paper="thermal_80mm"/,
    );
    expect(invoice.data?.orderDocument.html).toContain('انوائس');

    // Another shop's orders are left out; bad input is refused.
    const elsewhere = await gql(tokens.b, DOCUMENT, { ids: [id], kind: 'INVOICE' });
    expect(elsewhere.data?.orderDocument.orders).toEqual([]);
    const empty = await gql(tokens.a, DOCUMENT, { ids: [], kind: 'INVOICE' });
    expect(empty.errors?.[0]).toMatchObject({
      message: 'Ids must include at least one',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    const malformed = await gql(tokens.a, DOCUMENT, { ids: ['ord_1'], kind: 'INVOICE' });
    expect(malformed.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    const denied = await gql(tokens.aNoOrders, DOCUMENT, { ids: [id], kind: 'INVOICE' });
    expect(denied.errors?.[0]?.message).toContain('read_orders');
  });

  it('records refunds, up to what was paid', async () => {
    const [size] = await stockedVariants(tokens.a, 'Silk Dupatta', ['Free'], 3);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 1 }],
        shippingAddress: ADDRESS,
        paymentMethod: 'PREPAID',
      },
    });
    const id = created.order.id as string;
    const REFUND = `
      mutation ($id: ID!, $input: OrderRefundInput!) {
        orderRefund(id: $id, input: $input) {
          refund { id amount { formatted } method reference note createdAt }
          order {
            financialStatus amountPaid { formatted } amountRefunded { formatted } refunds { id }
          }
          userErrors { field code message }
        }
      }`;
    const refunded = await mutate(tokens.a, REFUND, {
      id,
      input: {
        amount: '1,000',
        method: 'BANK_TRANSFER',
        reference: 'IBFT-1',
        note: 'Faded colour',
      },
    });
    expect(refunded).toEqual({
      refund: {
        id: expect.stringMatching(/^rfd_/),
        amount: { formatted: 'Rs 1,000' },
        method: 'BANK_TRANSFER',
        reference: 'IBFT-1',
        note: 'Faded colour',
        createdAt: expect.any(String),
      },
      order: {
        financialStatus: 'PARTIALLY_REFUNDED',
        amountPaid: { formatted: 'Rs 3,499' },
        amountRefunded: { formatted: 'Rs 1,000' },
        refunds: [{ id: refunded.refund.id }],
      },
      userErrors: [],
    });
    expect(
      await mutate(tokens.a, REFUND, { id, input: { amount: '5000', method: 'CASH' } }),
    ).toEqual({
      refund: null,
      order: null,
      userErrors: [
        {
          field: ['input', 'amount'],
          code: 'INVALID',
          message: 'A refund can be at most Rs 2,499: what was paid and not refunded yet',
        },
      ],
    });
    // Money sent by hand keeps its receipt, an upload staged for it, shown for an hour (ADR-242).
    const staged = await mutate(
      await issueToken(shopA, ['write_files']),
      `mutation ($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl } }
      }`,
      { input: [{ filename: 'JazzCash.png', mimeType: 'image/png', fileSize: '64' }] },
    );
    const [target] = staged.stagedTargets;
    const local = (url: string) => url.replace('http://localhost:4000', '');
    const receiptPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(56, 3),
    ]);
    const uploaded = await app.inject({
      method: 'PUT',
      url: local(target.url),
      payload: receiptPng,
      headers: { 'content-type': 'image/png' },
    });
    expect(uploaded.statusCode).toBe(200);
    const withReceipt = await mutate(
      tokens.a,
      `mutation ($id: ID!, $input: OrderRefundInput!) {
        orderRefund(id: $id, input: $input) {
          refund { method receipt { mimeType fileSize url } }
          order { name refunds { receipt { fileSize } } }
          userErrors { field code message }
        }
      }`,
      {
        id,
        input: {
          amount: '500',
          method: 'MOBILE_WALLET',
          reference: 'JC-2',
          receipt: target.resourceUrl,
        },
      },
    );
    expect(withReceipt).toMatchObject({
      refund: { method: 'MOBILE_WALLET', receipt: { mimeType: 'image/png', fileSize: 64 } },
      order: { refunds: [{ receipt: null }, { receipt: { fileSize: 64 } }] },
      userErrors: [],
    });
    const shown = await app.inject({ method: 'GET', url: local(withReceipt.refund.receipt.url) });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-disposition']).toContain(
      `filename="Refund receipt ${withReceipt.order.name}-2.png"`,
    );
    expect(shown.rawPayload.equals(receiptPng)).toBe(true);

    const elsewhere = await mutate(tokens.b, REFUND, {
      id,
      input: { amount: '1', method: 'CASH' },
    });
    expect(elsewhere.userErrors).toEqual([
      { field: ['id'], code: 'NOT_FOUND', message: 'Order not found' },
    ]);
    const denied = await gql(tokens.aReader, REFUND, {
      id,
      input: { amount: '1', method: 'CASH' },
    });
    expect(denied.errors?.[0]?.message).toContain('write_orders');
  });

  it('exports orders as CSV for whoever can read them, and filters by when they were placed', async () => {
    const [size] = await stockedVariants(tokens.a, 'Ralli Quilt', ['Queen'], 5);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 2 }], shippingAddress: ADDRESS },
    });
    const EXPORT = `
      mutation ($query: String, $layout: OrderExportLayout, $placedFrom: DateTime) {
        ordersExport(query: $query, layout: $layout, placedFrom: $placedFrom) {
          csv rowCount userErrors { field code message }
        }
      }`;
    // Reading orders is enough, as it is to see them.
    const exported = await mutate(tokens.aReader, EXPORT, { query: created.order.name });
    expect(exported).toMatchObject({ rowCount: 1, userErrors: [] });
    const [header, row] = (exported.csv as string).split('\r\n');
    expect(header).toMatch(/^\uFEFFOrder,Order ID,Placed,Stage,/);
    expect(row).toContain(`${created.order.name},${created.order.id},`);
    expect(row).toContain(',2 × Ralli Quilt (Queen),2,');

    const lines = await mutate(tokens.aReader, EXPORT, {
      query: created.order.name,
      layout: 'LINE_ITEMS',
    });
    expect(lines.rowCount).toBe(1);
    // Its tax, none, between its total and the units shipped.
    expect(lines.csv).toContain(',1,Ralli Quilt,Queen,SKU-Queen,2,3499.00,6998.00,0.00,0,');

    const later = await mutate(tokens.aReader, EXPORT, {
      query: created.order.name,
      placedFrom: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(later.rowCount).toBe(0);
    const listed = await gql(
      tokens.aReader,
      'query ($before: DateTime) { orders(first: 5, placedBefore: $before) { nodes { id } } }',
      { before: '2020-01-01T00:00:00Z' },
    );
    expect(listed.data?.orders.nodes).toEqual([]);

    const elsewhere = await mutate(tokens.b, EXPORT, { query: created.order.name });
    expect(elsewhere.rowCount).toBe(0);
    const denied = await gql(tokens.aNoOrders, EXPORT, {});
    expect(denied.errors?.[0]?.message).toContain('read_orders');

    // As an Excel workbook, its bytes in base64 (ADR-182).
    const workbook = await mutate(
      tokens.aReader,
      `mutation ($query: String) {
        ordersExport(query: $query, format: XLSX) {
          csv rowCount file { filename contentType content } userErrors { field code message }
        }
      }`,
      { query: created.order.name },
    );
    expect(workbook).toMatchObject({
      csv: null,
      rowCount: 1,
      file: {
        filename: expect.stringMatching(/^orders-\d{4}-\d{2}-\d{2}\.xlsx$/),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      userErrors: [],
    });
    const [sheetHeader, sheetRow] = xlsxRows(Buffer.from(workbook.file.content, 'base64'));
    expect(sheetHeader!.slice(0, 4)).toEqual(['Order', 'Order ID', 'Placed', 'Stage']);
    expect(sheetRow!.slice(0, 2)).toEqual([created.order.name, created.order.id]);
    // 2 × Rs 3,499, a number.
    expect(sheetRow![sheetHeader!.indexOf('Subtotal')]).toBe(6998);
  });
});
