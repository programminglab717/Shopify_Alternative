import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { StorefrontApiClient, signUpsPath } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Storefront API: sign-ups through the online store's form", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'Other')`, [
      shopA,
      shopB,
    ]);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('keeps a sign-up as consent on WhatsApp, for storefronts with the key alone', async () => {
    const post = (headers: Record<string, string>, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: signUpsPath(shopA), headers, payload });
    expect((await post({}, { phone: '0300-1234567' })).statusCode).toBe(401);

    await app.listen(0, '127.0.0.1');
    const client = new StorefrontApiClient({
      baseUrl: await app.getUrl(),
      key: TEST_STOREFRONT_KEY,
    });
    expect(await client.signUp(shopA, { phone: '0300-1234567', tags: 'newsletter' })).toEqual({
      ok: true,
      created: true,
      subscribed: true,
    });
    expect(await client.signUp(shopA, { phone: '0300 123' })).toEqual({
      ok: false,
      errors: [
        { field: 'phone', message: 'Phone must be a Pakistani mobile number, like 0300 1234567' },
      ],
    });
    const { rows } = await admin.query<Record<string, unknown>>(
      `SELECT c.shop_id, c.phone, c.tags, c.whatsapp_consent, e.source, e.wording
         FROM customers.customers c JOIN customers.consent_events e
           ON e.shop_id = c.shop_id AND e.customer_id = c.id`,
    );
    expect(rows).toEqual([
      {
        shop_id: shopA,
        phone: '+923001234567',
        tags: ['newsletter'],
        whatsapp_consent: 'subscribed',
        source: 'storefront',
        wording:
          'Send me news and offers from Zari on WhatsApp\nمجھے Zari کی خبریں اور آفرز واٹس ایپ پر بھیجیں',
      },
    ]);
    // Not a shop's ID: nothing there.
    expect(
      (await client.signUp('not-a-shop', { phone: '0300-1234567' }).catch((e) => e)).status,
    ).toBe(404);
  });
});
