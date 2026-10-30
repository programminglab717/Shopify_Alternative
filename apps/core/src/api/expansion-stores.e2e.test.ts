import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { StaffRole } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import {
  ExpansionStoreService,
  MediaService,
  ProductExportService,
  ProductImportService,
  ProductService,
  VariantService,
} from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExpansionCopier } from '../expansion-copier.js';
import { CurrencyRates } from '../worker/currency-rates.js';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const STORE = 'shopId name currencyCode priceRate copiedAt lastCopy { created updated problems }';
const SAVE = `mutation ($shopId: ID!, $rate: String!) {
  expansionStoreSave(shopId: $shopId, priceRate: $rate) {
    expansionStore { ${STORE} } userErrors { field message } } }`;
const COPY = `mutation ($shopId: ID!) {
  expansionStoreCopy(shopId: $shopId) { expansionStore { ${STORE} } userErrors { message } } }`;
const AUTO = `mutation ($shopId: ID!, $enabled: Boolean!) {
  expansionStoreAutoCopySet(shopId: $shopId, enabled: $enabled) {
    expansionStore { autoCopy copyError copyFailedAt } userErrors { field message } } }`;
const FOLLOW = `mutation ($shopId: ID!, $enabled: Boolean!) {
  expansionStoreFollowRateSet(shopId: $shopId, enabled: $enabled) {
    expansionStore { priceRate followRate } userErrors { field message } } }`;
const PRODUCTS =
  '{ products(first: 10) { nodes { title status variants { price { amount currencyCode } } } } }';

describe.skipIf(!server)('Expansion stores (CH-11)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let database: Database;
  const zari = newId();
  const abroad = newId();
  const other = newId();
  const home = newId();
  const away = newId();

  async function account(shops: [string, StaffRole][]): Promise<{ token: string; userId: string }> {
    const post = (url: string, payload: object, token?: string) =>
      api.app.inject({
        method: 'POST',
        url,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    const body = (
      await post('/auth/sign-up', {
        email: `expansion-${randomBytes(4).toString('hex')}@example.pk`,
        password: 'correct horse battery staple',
        name: 'Saima Rauf',
      })
    ).json() as { accessToken: string; user: { id: string } };
    const userId = fromPublicId(body.user.id, 'user');
    for (const [shop, role] of shops) {
      await admin.query(
        'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
        [userId, shop, role],
      );
    }
    const { secret } = (await post('/auth/two-step/totp/setup', {}, body.accessToken)).json() as {
      secret: string;
    };
    await post(
      '/auth/two-step/totp/confirm',
      { code: totp(base32Decode(secret), Date.now()) },
      body.accessToken,
    );
    return { token: body.accessToken, userId };
  }

  async function data(token: string, shop: string, query: string, variables?: object) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: {
        authorization: `Bearer ${token}`,
        'x-hatti-shop-id': toPublicId('shop', shop),
        'idempotency-key': randomUUID(),
      },
      payload: { query, variables },
    });
    const body = response.json() as { data?: Record<string, Json>; errors?: Json[] };
    return body;
  }
  const value = async (token: string, shop: string, query: string, variables?: object) => {
    const body = await data(token, shop, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, currency)
       VALUES ($1, 'Zari', 'zari', 'PKR'), ($2, 'Zari Abroad', 'zari-abroad', 'USD'),
              ($3, 'Someone else', 'someone-else', 'USD'), ($4, 'Home', 'home', 'PKR'),
              ($5, 'Away', 'away', 'PKR')`,
      [zari, abroad, other, home, away],
    );
    api = await startTestApi(testDb);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'expansion-stores-test',
    });
  });

  afterAll(async () => {
    await database?.close();
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("copies the owner's products to their other shop at its rate, and updates them when copied again", async () => {
    const owner = await account([
      [zari, 'owner'],
      [abroad, 'owner'],
      [other, 'manager'],
    ]);
    await value(
      owner.token,
      zari,
      'mutation { productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,500" }] }) { product { id } } }',
    );

    // Neither a shop not owned, nor the shop itself, nor a rate of nothing.
    expect(
      (await value(owner.token, zari, SAVE, { shopId: toPublicId('shop', other), rate: '0.0036' }))
        .userErrors,
    ).toEqual([{ field: ['shopId'], message: 'You own no other shop of that ID' }]);
    expect(
      (await value(owner.token, zari, SAVE, { shopId: toPublicId('shop', zari), rate: '1' }))
        .userErrors,
    ).toEqual([{ field: ['shopId'], message: "A shop isn't its own expansion store" }]);
    expect(
      (await value(owner.token, zari, SAVE, { shopId: toPublicId('shop', abroad), rate: '0' }))
        .userErrors,
    ).toEqual([
      { field: ['priceRate'], message: 'Give the rate as a number above nothing, such as 0.0036' },
    ]);

    const saved = await value(owner.token, zari, SAVE, {
      shopId: toPublicId('shop', abroad),
      rate: '0.0036',
    });
    expect(saved.expansionStore).toEqual({
      shopId: toPublicId('shop', abroad),
      name: 'Zari Abroad',
      currencyCode: 'USD',
      priceRate: '0.0036',
      copiedAt: null,
      lastCopy: null,
    });

    const copied = await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    expect(copied.expansionStore.lastCopy).toEqual({ created: 1, updated: 0, problems: 0 });
    expect(copied.expansionStore.copiedAt).toEqual(expect.any(String));
    expect((await value(owner.token, abroad, PRODUCTS)).nodes).toEqual([
      {
        title: 'Kurta',
        status: 'ACTIVE',
        variants: [{ price: { amount: '9.00', currencyCode: 'USD' } }],
      },
    ]);

    // A new price here, copied again: updated there, not made twice.
    await value(owner.token, zari, SAVE, { shopId: toPublicId('shop', abroad), rate: '0.004' });
    const again = await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    expect(again.expansionStore.lastCopy).toEqual({ created: 0, updated: 1, problems: 0 });
    expect((await value(owner.token, abroad, PRODUCTS)).nodes[0].variants).toEqual([
      { price: { amount: '10.00', currencyCode: 'USD' } },
    ]);
    expect(await value(owner.token, zari, `{ expansionStores { name priceRate } }`)).toEqual([
      { name: 'Zari Abroad', priceRate: '0.004' },
    ]);

    // A margin over the rate, its prices rounded up to .99 (ADR-933): Rs 2,500 is $10 at the
    // rate, $11 with 10% over it, and $11.99 shown.
    const PRICING = `mutation ($shopId: ID!, $margin: Int!, $rounding: String!) {
      expansionStorePricingSet(shopId: $shopId, marginPercent: $margin, rounding: $rounding) {
        expansionStore { marginPercent rounding } userErrors { field message } } }`;
    const pricing = (margin: number, rounding: string) =>
      value(owner.token, zari, PRICING, { shopId: toPublicId('shop', abroad), margin, rounding });
    expect((await pricing(150, 'whole')).userErrors).toEqual([
      { field: ['marginPercent'], message: 'Margin percent must be a whole number from 0 to 100' },
    ]);
    expect((await pricing(10, 'cents')).userErrors).toEqual([
      { field: ['rounding'], message: 'Rounding must be exact, whole or ninety_nine' },
    ]);
    expect((await pricing(10, 'ninety_nine')).expansionStore).toEqual({
      marginPercent: 10,
      rounding: 'ninety_nine',
    });
    await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    expect((await value(owner.token, abroad, PRODUCTS)).nodes[0].variants).toEqual([
      { price: { amount: '11.99', currencyCode: 'USD' } },
    ]);

    // A collection's own margin (ADR-948): the kurta, on sale, 50% over the rate: $15, $15.99.
    const [{ id: kurta }] = (
      await value(owner.token, zari, '{ products(first: 1) { nodes { id } } }')
    ).nodes;
    const sale = (
      await value(
        owner.token,
        zari,
        'mutation ($products: [ID!]) { collectionCreate(input: { title: "Sale", products: $products }) { collection { id } } }',
        { products: [kurta] },
      )
    ).collection.id as string;
    const MARGINS = `mutation ($shopId: ID!, $margins: [ExpansionCollectionMarginInput!]!) {
      expansionStoreCollectionMarginsSet(shopId: $shopId, margins: $margins) {
        expansionStore { collectionMargins { collectionId collectionTitle marginPercent } }
        userErrors { field message } } }`;
    const margins = (list: { collectionId: string; marginPercent: number }[]) =>
      value(owner.token, zari, MARGINS, { shopId: toPublicId('shop', abroad), margins: list });
    expect((await margins([{ collectionId: sale, marginPercent: 150 }])).userErrors).toEqual([
      {
        field: ['margins', '0', 'marginPercent'],
        message: 'Margin percent must be a whole number from 0 to 100',
      },
    ]);
    expect(
      (await margins([{ collectionId: toPublicId('collection', newId()), marginPercent: 5 }]))
        .userErrors,
    ).toEqual([{ field: ['margins', '0', 'collectionId'], message: 'No such collection' }]);
    expect((await margins([{ collectionId: sale, marginPercent: 50 }])).expansionStore).toEqual({
      collectionMargins: [{ collectionId: sale, collectionTitle: 'Sale', marginPercent: 50 }],
    });
    await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    expect((await value(owner.token, abroad, PRODUCTS)).nodes[0].variants).toEqual([
      { price: { amount: '15.99', currencyCode: 'USD' } },
    ]);
    // A product's own margin (ADR-960), before its collection's: 20% over the rate, $12.99.
    const PRODUCT_MARGINS = `mutation ($shopId: ID!, $margins: [ExpansionProductMarginInput!]!) {
      expansionStoreProductMarginsSet(shopId: $shopId, margins: $margins) {
        expansionStore { productMargins { productId productTitle marginPercent } }
        userErrors { field message } } }`;
    const productMargins = (list: { productId: string; marginPercent: number }[]) =>
      value(owner.token, zari, PRODUCT_MARGINS, {
        shopId: toPublicId('shop', abroad),
        margins: list,
      });
    expect(
      (await productMargins([{ productId: toPublicId('product', newId()), marginPercent: 5 }]))
        .userErrors,
    ).toEqual([{ field: ['margins', '0', 'productId'], message: 'No such product' }]);
    expect(
      (
        await productMargins([
          { productId: kurta, marginPercent: 20 },
          { productId: kurta, marginPercent: 30 },
        ])
      ).userErrors,
    ).toEqual([{ field: ['margins'], message: 'Give each product one margin' }]);
    expect(
      (await productMargins([{ productId: kurta, marginPercent: 20 }])).expansionStore,
    ).toEqual({ productMargins: [{ productId: kurta, productTitle: 'Kurta', marginPercent: 20 }] });
    await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    expect((await value(owner.token, abroad, PRODUCTS)).nodes[0].variants).toEqual([
      { price: { amount: '12.99', currencyCode: 'USD' } },
    ]);
    await productMargins([]);
    // A product type's own margin (ADR-971), after its collection's: the kurta's type 30% over
    // the rate, $13.99 once the collection's is gone; a vendor's after a type's.
    expect(
      (
        await value(
          owner.token,
          zari,
          'mutation ($id: ID!) { productUpdate(input: { id: $id, productType: "Kurtas", vendor: "Zari" }) { userErrors { message } } }',
          { id: kurta },
        )
      ).userErrors,
    ).toEqual([]);
    const GROUP_MARGINS = `mutation ($shopId: ID!, $margins: [ExpansionGroupMarginInput!]!) {
      expansionStoreGroupMarginsSet(shopId: $shopId, margins: $margins) {
        expansionStore { groupMargins { by value marginPercent } }
        userErrors { field message } } }`;
    const groupMargins = (list: { by: string; value: string; marginPercent: number }[]) =>
      value(owner.token, zari, GROUP_MARGINS, {
        shopId: toPublicId('shop', abroad),
        margins: list,
      });
    expect(
      (await groupMargins([{ by: 'COLOUR', value: 'Red', marginPercent: 5 }])).userErrors,
    ).toEqual([{ field: ['margins', '0', 'by'], message: 'Choose a product type or vendor' }]);
    expect(
      (
        await groupMargins([
          { by: 'VENDOR', value: 'Zari', marginPercent: 40 },
          { by: 'VENDOR', value: ' zari ', marginPercent: 10 },
        ])
      ).userErrors,
    ).toEqual([{ field: ['margins'], message: 'Give each product type and vendor one margin' }]);
    expect(
      (
        await groupMargins([
          { by: 'VENDOR', value: 'Zari', marginPercent: 40 },
          { by: 'PRODUCT_TYPE', value: ' kurtas', marginPercent: 30 },
        ])
      ).expansionStore,
    ).toEqual({
      groupMargins: [
        { by: 'VENDOR', value: 'Zari', marginPercent: 40 },
        { by: 'PRODUCT_TYPE', value: 'kurtas', marginPercent: 30 },
      ],
    });
    await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    // Its collection's still first.
    expect((await value(owner.token, abroad, PRODUCTS)).nodes[0].variants).toEqual([
      { price: { amount: '15.99', currencyCode: 'USD' } },
    ]);
    await margins([]);
    await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    expect((await value(owner.token, abroad, PRODUCTS)).nodes[0].variants).toEqual([
      { price: { amount: '13.99', currencyCode: 'USD' } },
    ]);
    // Its vendor's, with no type's.
    await groupMargins([{ by: 'VENDOR', value: 'zari', marginPercent: 40 }]);
    await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    expect((await value(owner.token, abroad, PRODUCTS)).nodes[0].variants).toEqual([
      { price: { amount: '14.99', currencyCode: 'USD' } },
    ]);
    await groupMargins([]);
    // None: the store's own margin again.
    await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    expect((await value(owner.token, abroad, PRODUCTS)).nodes[0].variants).toEqual([
      { price: { amount: '11.99', currencyCode: 'USD' } },
    ]);

    // A manager of the shop keeps none of it.
    const manager = await account([[zari, 'manager']]);
    expect(
      (await data(manager.token, zari, COPY, { shopId: toPublicId('shop', abroad) })).errors?.[0]
        .extensions.code,
    ).toBe('ACCESS_DENIED');

    expect(
      (
        await value(
          owner.token,
          zari,
          'mutation ($shopId: ID!) { expansionStoreRemove(shopId: $shopId) { userErrors { message } } }',
          { shopId: toPublicId('shop', abroad) },
        )
      ).userErrors,
    ).toEqual([]);
    expect(await value(owner.token, zari, '{ expansionStores { name } }')).toEqual([]);
    // What was copied stays.
    expect((await value(owner.token, abroad, PRODUCTS)).nodes).toHaveLength(1);
  });

  it('copies as products change, once left alone, within the hour, and keeps why one failed (ADR-913)', async () => {
    const owner = await account([
      [home, 'owner'],
      [away, 'owner'],
    ]);
    const shop = (id: string) => toPublicId('shop', id);
    await value(owner.token, home, SAVE, { shopId: shop(away), rate: '1' });
    await value(
      owner.token,
      home,
      'mutation { productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "4,000" }] }) { product { id } } }',
    );
    // As the worker sweeps, with the login that reads across shops.
    const copier = new ExpansionCopier(
      database,
      new ExpansionStoreService(database),
      new ProductExportService(database),
      new ProductImportService(
        database,
        new ProductService(database),
        new MediaService(database),
        new VariantService(database),
      ),
    );
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

    // Copied only when asked, until turned on.
    expect(await copier.sweep(later(15))).toBe(0);
    expect(
      (await value(owner.token, home, AUTO, { shopId: shop(away), enabled: true })).expansionStore,
    ).toEqual({ autoCopy: true, copyError: null, copyFailedAt: null });
    // Changed just now: left alone ten minutes first.
    expect(await copier.sweep(later(5))).toBe(0);
    expect(await copier.sweep(later(15))).toBe(1);
    expect((await value(owner.token, away, PRODUCTS)).nodes).toEqual([
      {
        title: 'Shawl',
        status: 'ACTIVE',
        variants: [{ price: { amount: '4000.00', currencyCode: 'PKR' } }],
      },
    ]);
    // Nothing changed since: nothing to copy.
    expect(await copier.sweep(later(90))).toBe(0);

    // Copying back would copy each other's copies for ever.
    await value(owner.token, away, SAVE, { shopId: shop(home), rate: '1' });
    expect(
      (await value(owner.token, away, AUTO, { shopId: shop(home), enabled: true })).userErrors,
    ).toEqual([
      {
        field: ['shopId'],
        message: 'Products copied there come back here as they change: turn that off there first',
      },
    ]);

    // The expansion store no longer the owner's: kept with why, and not tried again in the hour.
    // A change after that copy, as of the sweeps' times.
    await admin.query(
      `UPDATE catalog.products SET updated_at = now() + interval '20 minutes' WHERE shop_id = $1`,
      [home],
    );
    await admin.query(`UPDATE identity.memberships SET role = 'manager' WHERE shop_id = $1`, [
      away,
    ]);
    expect(await copier.sweep(later(90))).toBe(0);
    const failed = (
      await value(owner.token, home, '{ expansionStores { copyError copyFailedAt } }')
    )[0];
    expect(failed).toEqual({
      copyError: 'The same person no longer owns both shops',
      copyFailedAt: expect.any(String),
    });
    await admin.query(`UPDATE identity.memberships SET role = 'owner' WHERE shop_id = $1`, [away]);
    expect(await copier.sweep(later(100))).toBe(0);
    expect(await copier.sweep(later(160))).toBe(1);
    expect((await value(owner.token, home, '{ expansionStores { copyError } }'))[0]).toEqual({
      copyError: null,
    });
  });

  it("follows the day's rate between the shops' currencies, copying again as it changes (ADR-929)", async () => {
    const pk = newId();
    const gulf = newId();
    const us = newId();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, currency)
       VALUES ($1, 'Lahore', 'lahore', 'PKR'), ($2, 'Dubai', 'dubai', 'AED'),
              ($3, 'Houston', 'houston', 'USD')`,
      [pk, gulf, us],
    );
    await admin.query(
      `INSERT INTO platform.currency_rates (currency, rate, rate_date, fetched_at)
       VALUES ('AED', 76.4521, current_date, now())
       ON CONFLICT (currency) DO UPDATE SET rate = excluded.rate`,
    );
    await admin.query(`DELETE FROM platform.currency_rates WHERE currency = 'USD'`);
    const owner = await account([
      [pk, 'owner'],
      [gulf, 'owner'],
      [us, 'owner'],
    ]);
    const shop = (id: string) => toPublicId('shop', id);
    await value(owner.token, pk, SAVE, { shopId: shop(gulf), rate: '0.013' });
    // Rs 1 is 1 / 76.4521 dirhams.
    expect(
      (await value(owner.token, pk, FOLLOW, { shopId: shop(gulf), enabled: true })).expansionStore,
    ).toEqual({ priceRate: '0.01308', followRate: true });
    // No day's rate for dollars: given by hand alone.
    await value(owner.token, pk, SAVE, { shopId: shop(us), rate: '0.0036' });
    expect(
      (await value(owner.token, pk, FOLLOW, { shopId: shop(us), enabled: true })).userErrors,
    ).toEqual([
      {
        field: ['shopId'],
        message: "Hatti has no day's rate between these shops' currencies: give a rate by hand",
      },
    ]);

    // The feed moves: the link takes the new rate, and copying as products change copies it.
    await value(owner.token, pk, AUTO, { shopId: shop(gulf), enabled: true });
    const stores = new ExpansionStoreService(database);
    const at = new Date(Date.now() + 60_000);
    // Its rate changed as it began following: a copy is due, at that rate.
    expect(await stores.dueForCopy(at)).toEqual([{ shopId: pk, targetShopId: gulf }]);
    // As a copy then would leave it.
    await admin.query(
      'UPDATE catalog.expansion_stores SET synced_at = $1 WHERE shop_id = $2 AND target_shop_id = $3',
      [at, pk, gulf],
    );
    const later = new Date(at.getTime() + 2 * 3_600_000);
    expect(await stores.dueForCopy(later)).toEqual([]);
    const feed = (async () =>
      new Response(JSON.stringify({ date: '2026-10-29', pkr: { aed: 0.0125 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    await new CurrencyRates(
      database,
      'https://feed.example/pkr.json',
      feed,
      undefined,
      stores,
    ).sweep(new Date(at.getTime() + 60_000));
    const [followed] = await value(owner.token, pk, '{ expansionStores { priceRate followRate } }');
    expect(followed).toEqual({ priceRate: '0.0125', followRate: true });
    expect(await stores.dueForCopy(later)).toEqual([{ shopId: pk, targetShopId: gulf }]);

    // A rate given by hand stops following.
    expect(
      (await value(owner.token, pk, SAVE, { shopId: shop(gulf), rate: '0.02' })).expansionStore
        .priceRate,
    ).toBe('0.02');
    expect((await value(owner.token, pk, '{ expansionStores { followRate } }'))[0]).toEqual({
      followRate: false,
    });
  });

  it("gives one page of each store's sales, in its currency and in this shop's at the day's rate, by this shop's days (ADR-932, ADR-955)", async () => {
    const lahore = newId();
    const dubai = newId();
    const sold = newId();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, currency)
       VALUES ($1, 'Lahore Lawn', 'lahore-lawn', 'PKR'), ($2, 'Dubai Lawn', 'dubai-lawn', 'AED'),
              ($3, 'Sold on', 'sold-on', 'AED')`,
      [lahore, dubai, sold],
    );
    await admin.query(
      `INSERT INTO platform.currency_rates (currency, rate, rate_date, fetched_at)
       VALUES ('AED', 76.4521, current_date, now())
       ON CONFLICT (currency) DO UPDATE SET rate = excluded.rate`,
    );
    // As the feed keeps it by its day too (ADR-974), the rates before forgotten.
    await admin.query(`DELETE FROM platform.currency_rate_history WHERE currency = 'AED'`);
    await admin.query(
      `INSERT INTO platform.currency_rate_history (currency, rate_date, rate)
       VALUES ('AED', current_date, 76.4521)`,
    );
    /** An order of `total` minor units in `shop`'s currency, placed now, each its own number. */
    let number = 1001;
    const order = async (
      shop: string,
      currency: string,
      total: number,
      phone = '+923001234567',
    ) => {
      const customer = newId();
      const id = newId();
      // A customer and their number at once, as each must name the other.
      await admin.query('BEGIN');
      await admin.query(
        `INSERT INTO customers.customers (shop_id, id, phone) VALUES ($1, $2, $3)`,
        [shop, customer, phone],
      );
      await admin.query(
        `INSERT INTO customers.customer_phones (shop_id, phone, customer_id)
         VALUES ($1, $3, $2)`,
        [shop, customer, phone],
      );
      await admin.query('COMMIT');
      await admin.query(
        `INSERT INTO orders.orders
           (shop_id, id, number, source, confirmation_status, financial_status, stage,
            payment_method, currency, subtotal, discount, shipping, total, amount_paid, cod_amount,
            phone, shipping_address, location_id, customer_id)
         VALUES ($1, $2, $8, 'online_store', 'pending', 'pending', 'needs_confirmation',
                 'cash_on_delivery', $3, $4, 0, 0, $4, 0, $4, $7, '{}', $5, $6)`,
        [shop, id, currency, total, newId(), customer, phone, number++],
      );
      await admin.query(
        `INSERT INTO orders.lines
           (shop_id, id, order_id, position, variant_id, product_id, title, variant_title,
            quantity, unit_price, total)
         VALUES ($1, $2, $3, 1, $4, $5, 'Lawn suit', 'M', 1, $6, $6)`,
        [shop, newId(), id, newId(), newId(), total],
      );
    };
    await order(lahore, 'PKR', 350_000);
    await order(dubai, 'AED', 10_000);
    await order(sold, 'AED', 99_900);
    const owner = await account([
      [lahore, 'owner'],
      [dubai, 'owner'],
      [sold, 'owner'],
    ]);
    const shop = (id: string) => toPublicId('shop', id);
    await value(owner.token, lahore, SAVE, { shopId: shop(dubai), rate: '0.0131' });
    await value(owner.token, lahore, SAVE, { shopId: shop(sold), rate: '0.0131' });
    // A store sold since: its owner is someone else now, and it is left out.
    await admin.query('DELETE FROM identity.memberships WHERE user_id = $1 AND shop_id = $2', [
      owner.userId,
      sold,
    ]);
    const SALES = `query ($from: DateTime!, $before: DateTime!) {
      expansionStoreSales(placedFrom: $from, placedBefore: $before) {
        shopId name here currencyCode orders
        totalSales { amount currencyCode } totalSalesHere { amount currencyCode } } }`;
    const period = {
      from: new Date(Date.now() - 86_400_000).toISOString(),
      before: new Date(Date.now() + 86_400_000).toISOString(),
    };
    expect(await value(owner.token, lahore, SALES, period)).toEqual([
      {
        shopId: shop(lahore),
        name: 'Lahore Lawn',
        here: true,
        currencyCode: 'PKR',
        orders: 1,
        totalSales: { amount: '3500.00', currencyCode: 'PKR' },
        totalSalesHere: { amount: '3500.00', currencyCode: 'PKR' },
      },
      {
        shopId: shop(dubai),
        name: 'Dubai Lawn',
        here: false,
        currencyCode: 'AED',
        orders: 1,
        // AED 100 at Rs 76.4521 each.
        totalSales: { amount: '100.00', currencyCode: 'AED' },
        totalSalesHere: { amount: '7645.21', currencyCode: 'PKR' },
      },
    ]);
    // Day by day in Lahore's time, whatever Dubai's (ADR-955): yesterday and today in Karachi,
    // each store's days the same, today's its order.
    await admin.query(`UPDATE control.shops SET timezone = 'Asia/Dubai' WHERE id = $1`, [dubai]);
    const DAYS = `query ($from: DateTime!, $before: DateTime!) {
      expansionStoreSales(placedFrom: $from, placedBefore: $before, interval: DAY) {
        name periods { start orders totalSales { amount } totalSalesHere { amount } } } }`;
    const day = 86_400_000;
    const karachi = 5 * 3_600_000;
    const today = Math.floor((Date.now() + karachi) / day) * day - karachi;
    const byDay = (await value(owner.token, lahore, DAYS, {
      from: new Date(today - day).toISOString(),
      before: new Date(today + day).toISOString(),
    })) as { name: string; periods: { start: string }[] }[];
    const starts = [new Date(today - day).toISOString(), new Date(today).toISOString()];
    expect(byDay.map((row) => row.periods.map((each) => each.start))).toEqual([starts, starts]);
    expect(byDay[1]).toEqual({
      name: 'Dubai Lawn',
      periods: [
        expect.objectContaining({ orders: 0, totalSalesHere: { amount: '0.00' } }),
        {
          start: starts[1],
          orders: 1,
          totalSales: { amount: '100.00' },
          totalSalesHere: { amount: '7645.21' },
        },
      ],
    });
    // From the Dubai store, rupees are dirhams at the day's rate; it has no stores of its own.
    expect(await value(owner.token, dubai, SALES, period)).toEqual([
      expect.objectContaining({
        here: true,
        totalSalesHere: { amount: '100.00', currencyCode: 'AED' },
      }),
    ]);
    // Each day at its own rate (ADR-974): yesterday's dirham was Rs 75, so an order of AED 10
    // yesterday is Rs 750, and the period's total is its days', each at its rate.
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(
      new Date(today - day),
    );
    await admin.query(
      `INSERT INTO platform.currency_rate_history (currency, rate_date, rate)
       VALUES ('AED', $1::date, 75.0000), ('AED', current_date, 76.4521)
       ON CONFLICT (currency, rate_date) DO UPDATE SET rate = excluded.rate`,
      [yesterday],
    );
    await order(dubai, 'AED', 1_000, '+923001234568');
    await admin.query(
      `UPDATE orders.orders SET created_at = $2 WHERE shop_id = $1 AND total = 1000`,
      [dubai, new Date(today - day / 2).toISOString()],
    );
    const TOTALS = `query ($from: DateTime!, $before: DateTime!) {
      expansionStoreSales(placedFrom: $from, placedBefore: $before, interval: DAY) {
        name totalSalesHere { amount } periods { totalSalesHere { amount } } } }`;
    const [, dubaiDays] = (await value(owner.token, lahore, TOTALS, {
      from: new Date(today - day).toISOString(),
      before: new Date(today + day).toISOString(),
    })) as {
      totalSalesHere: { amount: string };
      periods: { totalSalesHere: { amount: string } }[];
    }[];
    expect(dubaiDays!.periods.map((each) => each.totalSalesHere.amount)).toEqual([
      '750.00',
      '7645.21',
    ]);
    expect(dubaiDays!.totalSalesHere.amount).toBe('8395.21');
    // By week, each week its days', each at its own rate (ADR-975), however the weeks fall.
    const WEEKS = TOTALS.replace('interval: DAY', 'interval: WEEK');
    const [, dubaiWeeks] = (await value(owner.token, lahore, WEEKS, {
      from: new Date(today - day).toISOString(),
      before: new Date(today + day).toISOString(),
    })) as {
      totalSalesHere: { amount: string };
      periods: { totalSalesHere: { amount: string } }[];
    }[];
    expect(dubaiWeeks!.totalSalesHere.amount).toBe('8395.21');
    expect(
      dubaiWeeks!.periods.reduce((sum, each) => sum + Number(each.totalSalesHere.amount), 0),
    ).toBeCloseTo(8395.21, 2);

    // Staff but the owner see none of it.
    const manager = await account([[lahore, 'manager']]);
    const refused = await data(manager.token, lahore, SALES, period);
    expect(refused.errors?.[0]?.message).toContain('Only the shop');
  });
});
