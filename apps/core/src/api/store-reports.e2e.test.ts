import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { PublicSite, type TenantContext } from '@hatti/api';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { ProductService } from '@hatti/catalog/public';
import { MessagesService, MessagingSettingsService } from '@hatti/messaging/public';
import { StorefrontApiClient } from '@hatti/storefront-api';
import {
  AppealsService,
  ReportsService,
  RightsComplaintsService,
  TakedownsService,
} from '@hatti/trust/public';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refuseRightsCounter, releaseRights, upholdRights } from '../rights.js';
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

  it("takes a rights owner's complaint of the store's listings through the storefront API (ADR-474)", async () => {
    const listing = {
      id: newId(),
      title: 'Lawn 3-pc (master copy)',
      url: 'https://zari.hatti.test/products/lawn',
    };
    const complaint = {
      kind: 'counterfeit',
      rightsOwner: 'Gul Ahmed',
      complainant: 'Sana Iqbal',
      actingAs: 'agent',
      email: 'legal@example.pk',
      listings: [listing],
      details: 'Sold as Gul Ahmed lawn; it is a copy.',
      signature: 'Sana Iqbal',
      sworn: true,
      client: '203.0.113.9',
      language: 'en' as const,
    };
    const taken = await client.complainOfRights(shopId, complaint);
    if (!taken.ok) throw new Error(JSON.stringify(taken.errors));
    expect(taken.id).toMatch(/^ipc_/);
    expect(
      await client.complainOfRights(shopId, { ...complaint, sworn: false, listings: [] }),
    ).toEqual({
      ok: false,
      errors: [
        { field: 'listings', message: "Name the store's listings by their addresses" },
        { field: 'sworn', message: 'Swear the statement to send the complaint' },
      ],
    });
    const plain = await app.inject({
      method: 'POST',
      url: `/storefront/shops/${shopId}/rights-complaints`,
      payload: complaint,
    });
    expect(plain.statusCode).toBe(401);

    const [open] = await new RightsComplaintsService(database).list();
    expect(open).toMatchObject({
      id: fromPublicId(taken.id, 'rightsComplaint'),
      shopName: 'Zari',
      rightsOwner: 'Gul Ahmed',
      listings: [listing],
      status: 'open',
    });
  });

  it("upholds a rights complaint: its listings taken off sale and held, the store's owner told (ADR-475)", async () => {
    const tenant: TenantContext = {
      shopId,
      currency: 'PKR',
      actor: { kind: 'app', tokenId: newId() },
      scopes: new Set(['write_settings', 'write_products']),
    };
    expect(
      (
        await new MessagingSettingsService(database).update(tenant, {
          alertsPhone: '0333 5550009',
        })
      ).ok,
    ).toBe(true);
    const products = new ProductService(database);
    const created = await products.create(tenant, { title: 'Gul lawn', status: 'active' });
    if (!created.ok) throw new Error(JSON.stringify(created.errors));
    const lawn = created.value;
    const rights = new RightsComplaintsService(database);
    const taken = await rights.complain(shopId, {
      kind: 'counterfeit',
      rightsOwner: 'Gul Ahmed',
      complainant: 'Sana Iqbal',
      actingAs: 'agent',
      email: 'legal@example.pk',
      listings: [
        { id: lawn.id, title: 'Gul lawn', url: 'https://zari.hatti.test/products/gul-lawn' },
      ],
      details: 'Sold as Gul Ahmed lawn; it is a copy.',
      signature: 'Sana Iqbal',
      sworn: true,
    });
    if (!taken.ok) throw new Error(JSON.stringify(taken.errors));
    const messages = new MessagesService(database);
    const note = 'the label copies Gul Ahmed’s mark';

    const site = new PublicSite(await app.getUrl());
    const upheld = await upholdRights(database, rights, products, messages, site, taken.value.id, {
      by: 'Ayesha',
      note,
    });
    if (typeof upheld === 'string') throw new Error(upheld);
    expect(upheld.held).toEqual([{ id: lawn.id, title: 'Gul lawn' }]);
    expect(upheld.complaint).toMatchObject({
      status: 'upheld',
      decidedBy: 'Ayesha',
      decision: note,
    });
    const reference = toPublicId('rightsComplaint', taken.value.id);
    const { rows } = await admin.query<{ status: string; held_by: string }>(
      'SELECT status, held_by FROM catalog.products WHERE id = $1',
      [lawn.id],
    );
    expect(rows).toEqual([{ status: 'draft', held_by: reference }]);
    const told = async (kind: string) =>
      (
        await admin.query<{ kind: string; recipient: string; variables: Record<string, string> }>(
          `SELECT kind, recipient, variables FROM messaging.messages
            WHERE shop_id = $1 AND kind = $2`,
          [shopId, kind],
        )
      ).rows;
    const [notice] = await told('listings_taken_down');
    expect(notice).toEqual({
      kind: 'listings_taken_down',
      recipient: '+923335550009',
      variables: {
        shop: 'Zari',
        product: '"Gul lawn"',
        name: 'Sana Iqbal for Gul Ahmed',
        reference,
        note,
        email: 'legal@example.pk',
        url: expect.stringMatching(/\/rights\/[A-Za-z0-9_-]{32}$/),
      },
    });
    // Once; the shop can't put it on sale again.
    expect(
      await upholdRights(database, rights, products, messages, site, taken.value.id, {
        by: 'A',
        note,
      }),
    ).toBe('decided');
    expect(
      await upholdRights(database, rights, products, messages, site, newId(), { by: 'A', note }),
    ).toBe('not_found');
    const again = await products.update(tenant, { id: lawn.id, status: 'active' });
    expect(again.ok || again.errors[0]!.code).toBe('HELD');

    // The owner's page, by the notice's link: the complaint, and their answer, sworn, once.
    const link = new URL(notice!.variables.url!).pathname;
    const page = await app.inject({ method: 'GET', url: link });
    expect([page.statusCode, page.headers['cache-control'], page.headers['x-robots-tag']]).toEqual([
      200,
      'no-store',
      'noindex, nofollow',
    ]);
    expect(page.body).toContain('Listings taken down after a rights complaint');
    expect(page.body).toContain('Gul Ahmed');
    expect(page.body).toContain('legal@example.pk');
    expect(page.body).toContain(note);
    const post = (fields: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: link,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(fields).toString(),
      });
    const answer = { words: 'Our own label, woven in Faisalabad.', signature: 'Bilal' };
    const unsworn = await post(answer);
    expect(unsworn.statusCode).toBe(422);
    expect(unsworn.body).toContain('Tick the statement to send your answer.');
    expect(unsworn.body).toContain('Our own label, woven in Faisalabad.</textarea');
    const sent = await post({ ...answer, sworn: '1' });
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain('Hatti has your answer');
    expect((await post({ ...answer, sworn: '1' })).body).toContain(
      'You have answered this complaint already.',
    );
    expect((await app.inject({ method: 'GET', url: '/rights/nothing' })).statusCode).toBe(404);

    // Hatti's people see it, refuse it with why, and the owner is told; it stays held.
    const [waiting] = await rights.counters();
    expect(waiting).toMatchObject({
      id: taken.value.id,
      counterWords: answer.words,
      counterSignature: 'Bilal',
      counterStatus: 'open',
    });
    const refused = await refuseRightsCounter(database, rights, messages, taken.value.id, {
      by: 'Ayesha',
      answer: 'The label shows Gul Ahmed’s mark',
    });
    expect(refused).toMatchObject({ counterStatus: 'refused', counterAnsweredBy: 'Ayesha' });
    expect(
      await refuseRightsCounter(database, rights, messages, taken.value.id, {
        by: 'A',
        answer: 'x',
      }),
    ).toBe('answered');
    expect((await told('rights_counter_refused'))[0]!.variables).toEqual({
      shop: 'Zari',
      reference,
      note: 'The label shows Gul Ahmed’s mark',
    });
    expect((await app.inject({ method: 'GET', url: link })).body).toContain(
      'The label shows Gul Ahmed’s mark',
    );

    // Settled: let go, the owner told, and the shop puts it on sale again.
    const released = await releaseRights(database, rights, products, messages, taken.value.id, {
      by: 'Ayesha',
      note: 'Gul Ahmed withdrew the complaint',
    });
    if (typeof released === 'string') throw new Error(released);
    expect(released.released).toBe(1);
    expect(
      await releaseRights(database, rights, products, messages, taken.value.id, {
        by: 'A',
        note: 'x',
      }),
    ).toBe('answered');
    expect((await told('listings_released'))[0]!.variables).toEqual({
      shop: 'Zari',
      reference,
      note: 'Gul Ahmed withdrew the complaint',
    });
    const onSale = await products.update(tenant, { id: lawn.id, status: 'active' });
    expect(onSale.ok).toBe(true);
    expect((await app.inject({ method: 'GET', url: link })).body).toContain(
      'Your listings are let go',
    );
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
