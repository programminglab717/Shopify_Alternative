import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { PublicSite, type TenantContext } from '@hatti/api';
import { fromPublicId, newId } from '@hatti/ids';
import { MessagesService, MessagingSettingsService } from '@hatti/messaging/public';
import { StorefrontApiClient } from '@hatti/storefront-api';
import { AppealsService, ReportsService, TakedownsService } from '@hatti/trust/public';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refuseAppeal, restoreStore, takeDown } from '../takedowns.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Reports of stores, from storefronts to Hatti's people (ADR-460)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  let database: Database;
  let client: StorefrontApiClient;
  const shopId = newId();

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shopId]);
    api = await startTestApi(testDb);
    app = api.app;
    await app.listen(0, '127.0.0.1');
    client = new StorefrontApiClient({ baseUrl: await app.getUrl(), key: TEST_STOREFRONT_KEY });
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'store-reports-test',
    });
  });

  afterAll(async () => {
    await database?.close();
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('takes a report through the storefront API, numbered for the shopper, open for Hatti', async () => {
    const report = {
      reason: 'never_delivered',
      details: 'Paid an advance; nothing came.',
      phone: '0300 1234567',
      pageUrl: 'https://zari.hatti.test/products/lawn',
      client: '203.0.113.9',
      language: 'ur' as const,
    };
    const taken = await client.report(shopId, report);
    if (!taken.ok) throw new Error(JSON.stringify(taken.errors));
    expect(taken.id).toMatch(/^rpt_/);
    expect(await client.report(shopId, { ...report, reason: 'rude', phone: '123' })).toEqual({
      ok: false,
      errors: [
        { field: 'reason', message: 'Say what is wrong' },
        { field: 'phone', message: 'Enter a Pakistani mobile number' },
      ],
    });
    // Only for the storefronts, with their key; and only for shops there are.
    const plain = await app.inject({
      method: 'POST',
      url: `/storefront/shops/${shopId}/reports`,
      payload: report,
    });
    expect(plain.statusCode).toBe(401);
    expect((await client.report(newId(), report)).ok).toBe(false);

    const [open] = await new ReportsService(database).list();
    expect(open).toMatchObject({
      id: fromPublicId(taken.id, 'storeReport'),
      shopName: 'Zari',
      phone: '+923001234567',
      language: 'ur',
      status: 'open',
      openOfShop: 1,
    });
  });

  it('takes the store down once, its owner told why with the link to appeal by, and restores it, told again (ADR-461, ADR-462)', async () => {
    const tenant: TenantContext = {
      shopId,
      currency: 'PKR',
      actor: { kind: 'app', tokenId: newId() },
      scopes: new Set(['write_settings']),
    };
    const settings = await new MessagingSettingsService(database).update(tenant, {
      alertsPhone: '0333 5550009',
    });
    expect(settings.ok).toBe(true);
    const takedowns = new TakedownsService(database);
    const appeals = new AppealsService(database);
    const messages = new MessagesService(database);
    const site = new PublicSite(await app.getUrl());
    const told = async () =>
      (
        await admin.query<{
          kind: string;
          channel: string;
          recipient: string;
          variables: Record<string, string>;
        }>(
          `SELECT kind, channel, recipient, variables FROM messaging.messages
            WHERE shop_id = $1 AND kind LIKE 'store_%' ORDER BY created_at, id`,
          [shopId],
        )
      ).rows;
    const handle = (
      await admin.query<{ handle: string }>('SELECT handle FROM control.shops WHERE id = $1', [
        shopId,
      ])
    ).rows[0]!.handle;

    const note = 'advances taken for orders never sent';
    const down = await takeDown(database, takedowns, messages, site, handle, {
      reason: 'scam',
      note,
      by: 'Ayesha',
    });
    expect(down).toMatchObject({ shopId, reason: 'scam', takenBy: 'Ayesha' });
    const [suspended] = await told();
    expect(suspended).toMatchObject({
      kind: 'store_suspended',
      channel: 'whatsapp',
      recipient: '+923335550009',
      variables: { shop: 'Zari', note },
    });
    const link = new URL(suspended!.variables.url!);
    expect(link.pathname).toMatch(/^\/appeal\/[A-Za-z0-9_-]{32}$/);
    // Down once at a time.
    expect(
      await takeDown(database, takedowns, messages, site, handle, {
        reason: 'scam',
        note,
        by: 'A',
      }),
    ).toBe('not_active');

    // The owner's page: why, and their side of it, sent as a form; never kept or indexed.
    const page = await app.inject({ method: 'GET', url: link.pathname });
    expect([page.statusCode, page.headers['cache-control'], page.headers['x-robots-tag']]).toEqual([
      200,
      'no-store',
      'noindex, nofollow',
    ]);
    expect(page.body).toContain('Your store is taken down');
    expect(page.body).toContain(note);
    const post = (words: string) =>
      app.inject({
        method: 'POST',
        url: link.pathname,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ words }).toString(),
      });
    expect((await post('   ')).statusCode).toBe(422);
    const sent = await post('Every order was sent; I have the courier receipts.');
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain('Hatti has your appeal');
    expect((await app.inject({ method: 'GET', url: '/appeal/nothing' })).statusCode).toBe(404);

    const [waiting] = await appeals.list();
    expect(waiting).toMatchObject({
      shopId,
      words: 'Every order was sent; I have the courier receipts.',
    });
    const refused = await refuseAppeal(database, appeals, messages, waiting!.id, {
      by: 'Bilal',
      answer: 'the receipts show none delivered',
    });
    expect(refused).toMatchObject({ status: 'refused' });
    expect((await app.inject({ method: 'GET', url: link.pathname })).body).toContain(
      'the receipts show none delivered',
    );
    expect((await post('Refunded every advance today.')).statusCode).toBe(200);

    // Restoring it upholds the appeal waiting.
    const reopened = await restoreStore(database, takedowns, messages, shopId, {
      note: 'every advance refunded',
      by: 'Bilal',
    });
    expect(reopened).toMatchObject({ restoredBy: 'Bilal', restoreNote: 'every advance refunded' });
    expect((await told()).map((message) => [message.kind, message.variables])).toEqual([
      ['store_suspended', { shop: 'Zari', note, url: link.href }],
      ['store_appeal_refused', { shop: 'Zari', note: 'the receipts show none delivered' }],
      ['store_restored', { shop: 'Zari', note: 'every advance refunded' }],
    ]);
    expect((await appeals.list({ all: true })).map((appeal) => appeal.status)).toEqual([
      'upheld',
      'refused',
    ]);
    expect(await restoreStore(database, takedowns, messages, shopId, { note: 'x', by: 'B' })).toBe(
      'not_suspended',
    );
  });
});
