import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken, type StaffRole } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SESSION = `id closedAt salesCount gross { amount } discounts { amount } returnsCount
  returned { amount } tenders { method amount { amount } } cashIn { amount } cashOut { amount }
  expectedCash { amount } countedCash { amount } difference { amount }`;

const SALE = `id name clientId customerId subtotal { amount } discount { amount } total { amount }
  changeGiven { amount } returned { amount }
  lines { id title quantity unitPrice { amount } discount { amount } total { amount } returnedQuantity }
  tenders { method amount { amount } reference }`;

const SELL = `mutation ($input: PosSaleInput!) {
  posSaleCreate(input: $input) { sale { ${SALE} } userErrors { field code message } } }`;

const RETURN = `mutation ($input: PosReturnInput!) {
  posSaleReturn(input: $input) { sale { ${SALE} } userErrors { field code message } } }`;

describe.skipIf(!server)("The shop's till: registers, sessions, sales and returns (POS-01)", () => {
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

  /** What a product's one variant has on hand and available. */
  async function stock(productId: string): Promise<[number, number]> {
    const read = await data(
      `query ($id: ID!) {
        product(id: $id) { variants { inventoryItem { inventoryLevels { onHand available } } } }
      }`,
      { id: productId },
    );
    const [level] = read.variants[0].inventoryItem.inventoryLevels;
    return [level.onHand, level.available];
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
      'write_settings',
      'write_customers',
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

  it('sells from a register’s shelf, once, gives change, takes returns, and closes with a Z report', async () => {
    const save = `mutation ($input: PosRegisterInput!) {
      posRegisterSave(input: $input) { register { id name locationId openSessionId }
        userErrors { field code } } }`;
    const saved = await data(save, { input: { name: 'Counter 1', locationId: location } });
    expect(saved.register).toMatchObject({ name: 'Counter 1', locationId: location });
    const register = saved.register.id as string;
    expect(
      (await data(save, { input: { name: 'counter 1', locationId: location } })).userErrors,
    ).toEqual([{ field: ['input', 'name'], code: 'TAKEN' }]);

    const open = `mutation ($id: ID!, $float: String!) {
      posSessionOpen(registerId: $id, openingFloat: $float) { session { ${SESSION} }
        userErrors { field code } } }`;
    const opened = await data(open, { id: register, float: '5,000' });
    expect(opened.session.expectedCash.amount).toBe('5000.00');
    const session = opened.session.id as string;
    // One session a register at a time.
    expect((await data(open, { id: register, float: '0' })).userErrors[0].code).toBe('INVALID');
    expect((await data('{ posRegisters { openSessionId } }'))[0].openSessionId).toBe(session);

    const suit = await stocked('Lawn Suit', '3,000', 5);
    // None recorded on the shelf: it sells all the same, the count wrong, not the shopper.
    const dupatta = await stocked('Chiffon Dupatta', '1,500', 0);
    // What the till sells, with its shelf's stock, to find by title, SKU or barcode offline.
    const catalog = await data(
      `query ($id: ID!) { posCatalog(registerId: $id) {
        variantId productTitle variantTitle price { amount } available } }`,
      { id: register },
    );
    expect(catalog).toEqual([
      {
        variantId: dupatta.variant,
        productTitle: 'Chiffon Dupatta',
        variantTitle: 'Default Title',
        price: { amount: '1500.00' },
        available: 0,
      },
      {
        variantId: suit.variant,
        productTitle: 'Lawn Suit',
        variantTitle: 'Default Title',
        price: { amount: '3000.00' },
        available: 5,
      },
    ]);
    const clientId = randomUUID();
    const sale = {
      clientId,
      sessionId: session,
      lines: [
        { variantId: suit.variant, quantity: 2 },
        { variantId: dupatta.variant, quantity: 1 },
      ],
      discount: '500',
      customerPhone: '0300 1234567',
      tenders: [{ method: 'CASH', amount: '8,000' }],
    };
    const sold = await data(SELL, { input: sale });
    expect(sold.userErrors).toEqual([]);
    expect(sold.sale).toMatchObject({
      name: '#P1',
      clientId,
      subtotal: { amount: '7500.00' },
      discount: { amount: '500.00' },
      total: { amount: '7000.00' },
      changeGiven: { amount: '1000.00' },
      tenders: [{ method: 'CASH', amount: { amount: '8000.00' }, reference: null }],
    });
    // The discount shared in proportion: 400 off the suits, 100 off the dupatta.
    expect(sold.sale.lines.map((line: Json) => [line.title, line.total.amount])).toEqual([
      ['Lawn Suit', '5600.00'],
      ['Chiffon Dupatta', '1400.00'],
    ]);
    expect(sold.sale.customerId).toMatch(/^cus_/);
    expect(await stock(suit.product)).toEqual([3, 3]);
    expect(await stock(dupatta.product)).toEqual([-1, -1]);
    // Sent again, as an offline till does: the same sale, nothing taken twice.
    const again = await data(SELL, { input: sale });
    expect(again.sale.id).toBe(sold.sale.id);
    expect(await stock(suit.product)).toEqual([3, 3]);

    // Change comes from cash alone; nothing is sold short of its total.
    const card = await data(SELL, {
      input: {
        ...sale,
        clientId: randomUUID(),
        discount: null,
        tenders: [{ method: 'CARD', amount: '9,000' }],
      },
    });
    expect(card.userErrors[0].message).toBe('Change is given from cash alone');
    const short = await data(SELL, {
      input: { ...sale, clientId: randomUUID(), tenders: [{ method: 'CASH', amount: '100' }] },
    });
    expect(short.userErrors[0].message).toBe('What was paid is less than the total');

    const move = `mutation ($id: ID!) {
      posCashMove(sessionId: $id, out: true, amount: "2,000", note: "Bank deposit") {
        session { ${SESSION} } userErrors { field code } } }`;
    expect((await data(move, { id: session })).session.expectedCash.amount).toBe('10000.00');

    // One suit back: what was paid for it back from the drawer, and it back on the shelf.
    const [suitLine] = sold.sale.lines;
    const returned = await data(RETURN, {
      input: {
        saleId: sold.sale.id,
        sessionId: session,
        lines: [{ lineId: suitLine.id, quantity: 1 }],
        restock: true,
        method: 'CASH',
        reason: 'Wrong size',
      },
    });
    expect(returned.sale.returned.amount).toBe('2800.00');
    expect(returned.sale.lines[0].returnedQuantity).toBe(1);
    expect(await stock(suit.product)).toEqual([4, 4]);
    const more = await data(RETURN, {
      input: {
        saleId: sold.sale.id,
        sessionId: session,
        lines: [{ lineId: suitLine.id, quantity: 2 }],
        restock: true,
        method: 'CASH',
      },
    });
    expect(more.userErrors[0].message).toBe('Only 1 of it can still come back');

    const close = `mutation ($id: ID!) {
      posSessionClose(sessionId: $id, countedCash: "7,000", note: "200 short") {
        session { ${SESSION} } userErrors { field code } } }`;
    const report = (await data(close, { id: session })).session;
    expect(report).toMatchObject({
      salesCount: 1,
      gross: { amount: '7500.00' },
      discounts: { amount: '500.00' },
      returnsCount: 1,
      returned: { amount: '2800.00' },
      cashOut: { amount: '2000.00' },
      // 5,000 float + 8,000 taken − 1,000 change − 2,000 banked − 2,800 paid back.
      expectedCash: { amount: '7200.00' },
      countedCash: { amount: '7000.00' },
      difference: { amount: '-200.00' },
      tenders: [{ method: 'CASH', amount: { amount: '4200.00' } }],
    });
    expect(report.closedAt).not.toBeNull();
    // Nothing is sold on a closed session.
    const late = await data(SELL, { input: { ...sale, clientId: randomUUID() } });
    expect(late.userErrors[0].message).toBe('The register’s session is closed');

    const listed = await data(
      `query ($id: ID!) { posSales(sessionId: $id) { nodes { name } pageInfo { hasNextPage } } }`,
      { id: session },
    );
    expect(listed.nodes).toEqual([{ name: '#P1' }]);
    const theirs = await data(`query ($id: ID!) { posSales(customerId: $id) { nodes { name } } }`, {
      id: sold.sale.customerId,
    });
    expect(theirs.nodes).toEqual([{ name: '#P1' }]);
  });

  it('hands over click-and-collect orders, and sends orders home, the money in the drawer (ADR-873)', async () => {
    const register = (
      await data(
        `mutation ($input: PosRegisterInput!) {
          posRegisterSave(input: $input) { register { id } userErrors { code } } }`,
        { input: { name: 'Counter 2', locationId: location } },
      )
    ).register.id as string;
    const session = (
      await data(
        `mutation ($id: ID!) {
          posSessionOpen(registerId: $id, openingFloat: "1,000") { session { id } } }`,
        { id: register },
      )
    ).session.id as string;
    await data(
      `mutation ($id: ID!) {
        locationEdit(id: $id, input: { address: { address1: "Shop 4, Liberty Market", city: "lhr" } }) {
          userErrors { code } } }`,
      { id: location },
    );
    await data(
      `mutation ($settings: LocalPickupSettingsInput!) {
        locationLocalPickupEnable(localPickupSettings: $settings) { userErrors { code } } }`,
      { settings: { locationId: location, instructions: 'Ask at the counter' } },
    );
    const kurta = await stocked('Khaddar Kurta', '2,500', 5);
    const address = {
      name: 'Ayesha Khan',
      phone: '0300 7654321',
      address1: 'House 12, Street 4',
      city: 'lhr',
    };
    const placed = await data(
      `mutation ($input: OrderCreateInput!) {
        orderCreate(input: $input) { order { id name } userErrors { field code message } } }`,
      {
        input: {
          lineItems: [{ variantId: kurta.variant, quantity: 1 }],
          shippingAddress: address,
          deliveryMethod: 'PICKUP',
        },
      },
    );
    const order = placed.order.id as string;
    const pickups = `query ($id: ID!) {
      posPickups(registerId: $id) { orderId name customerName owed { amount } ready } }`;
    // Waiting for the customer to confirm: not to hand over yet.
    expect(await data(pickups, { id: register })).toEqual([
      {
        orderId: order,
        name: placed.order.name,
        customerName: 'Ayesha Khan',
        owed: { amount: '2500.00' },
        ready: false,
      },
    ]);
    await data(`mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { code } } }`, {
      id: order,
    });
    const hand = `mutation ($session: ID!, $order: ID!) {
      posPickupHandOver(sessionId: $session, orderId: $order) {
        orderId paid { amount } userErrors { field code message } } }`;
    const handed = await data(hand, { session, order });
    expect(handed).toMatchObject({ orderId: order, paid: { amount: '2500.00' }, userErrors: [] });
    const done = await data(
      `query ($id: ID!) { order(id: $id) { stage financialStatus amountPaid { amount } } }`,
      { id: order },
    );
    expect(done).toEqual({
      stage: 'COMPLETED',
      financialStatus: 'PAID',
      amountPaid: { amount: '2500.00' },
    });
    expect(await data(pickups, { id: register })).toEqual([]);
    expect((await data(hand, { session, order })).userErrors).not.toEqual([]);

    // Sent home from the till: confirmed by the customer there, its advance in the drawer.
    const sent = await data(
      `mutation ($input: PosDeliveryOrderInput!) {
        posOrderCreate(input: $input) {
          order { id name total { amount } paid { amount } } userErrors { field code message } } }`,
      {
        input: {
          sessionId: session,
          lines: [{ variantId: kurta.variant, quantity: 2 }],
          address: { ...address, city: 'khi' },
          payment: 'ADVANCE',
          advance: '1,000',
        },
      },
    );
    expect(sent.userErrors).toEqual([]);
    expect(sent.order).toMatchObject({ total: { amount: '5000.00' }, paid: { amount: '1000.00' } });
    const home = await data(
      `query ($id: ID!) { order(id: $id) {
        source confirmationStatus amountPaid { amount } tags } }`,
      { id: sent.order.id },
    );
    expect(home).toEqual({
      source: 'POS',
      confirmationStatus: 'CONFIRMED',
      amountPaid: { amount: '1000.00' },
      tags: ['pos'],
    });
    const report = await data(
      `query ($id: ID!) { posSession(id: $id) {
        ordersPaidCount ordersPaid { amount } expectedCash { amount }
        tenders { method amount { amount } } } }`,
      { id: session },
    );
    expect(report).toEqual({
      ordersPaidCount: 2,
      ordersPaid: { amount: '3500.00' },
      // 1,000 float + 2,500 collected + 1,000 advance.
      expectedCash: { amount: '4500.00' },
      tenders: [{ method: 'CASH', amount: { amount: '3500.00' } }],
    });
  });

  it('signs cashiers in with their own PINs, each sale naming who rang it up (POS-07, ADR-874)', async () => {
    const post = (url: string, payload: object, bearer?: string) =>
      app.inject({
        method: 'POST',
        url,
        payload,
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      });
    async function staff(role: StaffRole): Promise<string> {
      const body = (
        await post('/auth/sign-up', {
          email: `till-${randomUUID().slice(0, 8)}@example.pk`,
          password: 'correct horse battery staple',
          name: 'Hina Akhtar',
        })
      ).json() as { accessToken: string; user: { id: string } };
      await admin.query(
        'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
        [fromPublicId(body.user.id, 'user'), shop, role],
      );
      const { secret } = (await post('/auth/two-step/totp/setup', {}, body.accessToken)).json() as {
        secret: string;
      };
      await post(
        '/auth/two-step/totp/confirm',
        { code: totp(base32Decode(secret), Date.now()) },
        body.accessToken,
      );
      return body.accessToken;
    }
    const as = async (bearer: string, query: string, variables?: Record<string, unknown>) => {
      const response = await app.inject({
        method: 'POST',
        url: ADMIN_GRAPHQL_PATH,
        headers: {
          authorization: `Bearer ${bearer}`,
          'x-hatti-shop-id': toPublicId('shop', shop),
          'idempotency-key': randomUUID(),
        },
        payload: { query, variables },
      });
      const body = response.json<{ data?: Json; errors?: Json[] }>();
      expect(body.errors).toBeUndefined();
      return Object.values(body.data ?? {})[0] as Json;
    };
    const owner = await staff('owner');
    const manager = await staff('manager');
    const SET = `mutation ($pin: String!, $name: String!) {
      posPinSet(pin: $pin, name: $name) { pin { set name } userErrors { field code message } } }`;
    expect((await as(owner, SET, { pin: '1234', name: 'Hina' })).userErrors[0].message).toBe(
      'Choose a PIN harder to guess than 1111 or 1234',
    );
    expect(await as(owner, SET, { pin: '4071', name: 'Hina' })).toEqual({
      pin: { set: true, name: 'Hina' },
      userErrors: [],
    });
    // No two members share one.
    expect((await as(manager, SET, { pin: '4071', name: 'Bilal' })).userErrors[0].code).toBe(
      'TAKEN',
    );
    await as(manager, SET, { pin: '58203', name: 'Bilal' });
    expect(await as(manager, '{ posPin { set name } }')).toEqual({ set: true, name: 'Bilal' });
    // An app has no PIN of its own.
    expect((await data(SET, { pin: '9917', name: 'App' })).userErrors[0].field).toEqual(['pin']);

    const register = (
      await data(
        `mutation ($input: PosRegisterInput!) {
          posRegisterSave(input: $input) { register { id } } }`,
        { input: { name: 'Counter 3', locationId: location } },
      )
    ).register.id as string;
    const OPEN = `mutation ($id: ID!) {
      posSessionOpen(registerId: $id, openingFloat: "0") { session { id } } }`;
    const session = (await as(manager, OPEN, { id: register })).session.id as string;
    const SIGN_IN = `mutation ($session: ID!, $pin: String!) {
      posCashierSignIn(sessionId: $session, pin: $pin) {
        cashier { name token expiresAt } userErrors { field code message } } }`;
    const signed = await as(manager, SIGN_IN, { session, pin: '58203' });
    expect(signed.cashier.name).toBe('Bilal');
    const shawl = await stocked('Pashmina Shawl', '4,000', 3);
    const sale = (token: string | null) => ({
      clientId: randomUUID(),
      sessionId: session,
      lines: [{ variantId: shawl.variant, quantity: 1 }],
      tenders: [{ method: 'CASH', amount: '4,000' }],
      ...(token && { cashierToken: token }),
    });
    const SOLD = `mutation ($input: PosSaleInput!) {
      posSaleCreate(input: $input) { sale { name cashierName } userErrors { field message } } }`;
    expect((await as(manager, SOLD, { input: sale(signed.cashier.token) })).sale.cashierName).toBe(
      'Bilal',
    );
    expect((await as(manager, SOLD, { input: sale(null) })).sale.cashierName).toBeNull();
    // A token is its session's alone, and can't be made up.
    const forged = await as(manager, SOLD, { input: sale('v1.x.y.z') });
    expect(forged.userErrors[0].field).toEqual(['input', 'cashierToken']);
    const report = await as(
      manager,
      `query ($id: ID!) { posSession(id: $id) { cashiers { name salesCount total { amount } } } }`,
      { id: session },
    );
    expect(report.cashiers).toEqual([
      { name: 'Bilal', salesCount: 1, total: { amount: '4000.00' } },
      { name: null, salesCount: 1, total: { amount: '4000.00' } },
    ]);

    // Five wrong PINs lock the session's sign-ins, the right one too.
    for (let wrong = 0; wrong < 5; wrong += 1) {
      expect((await as(manager, SIGN_IN, { session, pin: '1111' })).userErrors[0].code).toBe(
        'INVALID',
      );
    }
    expect((await as(owner, SIGN_IN, { session, pin: '4071' })).userErrors[0].code).toBe(
      'TOO_MANY',
    );
  });
});
