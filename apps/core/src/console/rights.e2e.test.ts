import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { ProductService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import { MessagingSettingsService, SmsSendersService } from '@hatti/messaging/public';
import { RightsComplaintsService } from '@hatti/trust/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleAgentToken, startTestConsole, type TestConsole } from '../testing/console.js';
import { fakeOidcProvider } from '../testing/oidc-provider.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const CLIENT = { id: 'hatti-console', secret: 'the-console-secret-of-hatti' };

describe.skipIf(!server)(
  "Hatti's console: rights complaints, flagged listings, scam signs and sender names (ADR-878)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let database: Database;
    let testConsole: TestConsole;
    let provider: Awaited<ReturnType<typeof fakeOidcProvider>>;
    let token = '';
    const shop = newId();
    let tenant: TenantContext;

    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const response = await testConsole.app.inject({
        method,
        url: `/console/api${url}`,
        ...(payload && { payload }),
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.statusCode, body: response.json() as Json };
    };

    /** What the shop was told, by kind. */
    const told = async () =>
      (
        await admin.query<{ kind: string; variables: Record<string, string> }>(
          `SELECT kind, variables FROM messaging.messages
            WHERE shop_id = $1 AND (kind LIKE 'listings_%' OR kind LIKE 'rights_%'
                  OR kind LIKE 'sms_sender_%')
            ORDER BY created_at, id`,
          [shop],
        )
      ).rows;

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`,
        [shop],
      );
      database = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'console-rights-test',
      });
      tenant = {
        shopId: shop,
        currency: 'PKR',
        actor: { kind: 'app', tokenId: newId() },
        scopes: new Set(['write_settings', 'write_products']),
      };
      await new MessagingSettingsService(database).update(tenant, {
        alertsPhone: '0333 5550009',
      });
      provider = await fakeOidcProvider(CLIENT);
      testConsole = await startTestConsole(testDb, {
        issuer: provider.issuer,
        clientId: CLIENT.id,
        clientSecret: CLIENT.secret,
        consoleUrl: 'https://console.hatti.example',
      });
      token = await consoleAgentToken(testConsole, admin, provider, 'bilal@hatti.pk', 'Bilal');
    });

    afterAll(async () => {
      await testConsole?.close();
      provider?.http.close();
      await database?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it("upholds a rights complaint, refuses the owner's answer, then lets the listings go", async () => {
      const products = new ProductService(database);
      const created = await products.create(tenant, { title: 'Gul lawn', status: 'active' });
      if (!created.ok) throw new Error('no product');
      const lawn = created.value;
      const rights = new RightsComplaintsService(database);
      const complaint = (whose: string) =>
        rights.complain(shop, {
          kind: 'counterfeit',
          rightsOwner: whose,
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
      const first = await complaint('Gul Ahmed');
      const second = await complaint('Khaadi');
      if (!first.ok || !second.ok) throw new Error('not taken');
      const id = toPublicId('rightsComplaint', first.value.id);
      const other = toPublicId('rightsComplaint', second.value.id);

      const open = (await call('GET', '/rights')).body.complaints;
      expect(open.map((each: Json) => each.id).sort()).toEqual([id, other].sort());
      expect(open.find((each: Json) => each.id === id)).toMatchObject({
        shop: { handle: 'zari' },
        rightsOwner: 'Gul Ahmed',
        email: 'legal@example.pk',
        listings: [{ id: toPublicId('product', lawn.id), title: 'Gul lawn' }],
        status: 'open',
        counter: null,
      });
      expect(
        (await call('POST', `/rights/${other}/dismiss`, { note: 'Its own label' })).body,
      ).toMatchObject({ complaint: { status: 'dismissed', decidedBy: 'Bilal' } });

      const upheld = await call('POST', `/rights/${id}/uphold`, {
        note: 'The label copies Gul Ahmed’s mark',
      });
      expect(upheld.body).toMatchObject({ complaint: { status: 'upheld' }, held: 1 });
      expect((await call('POST', `/rights/${id}/uphold`, { note: 'Again' })).status).toBe(409);
      expect(
        (await admin.query('SELECT status FROM catalog.products WHERE id = $1', [lawn.id])).rows[0],
      ).toEqual({ status: 'draft' });
      // No answer of the owner's waits yet.
      expect((await call('POST', `/rights/${id}/refuse-answer`, { answer: 'No' })).status).toBe(
        409,
      );

      const [takenDown] = await told();
      const link = new URL(takenDown!.variables.url!);
      expect(link.origin).toBe('https://hatti.example');
      await rights.counter(link.pathname.split('/').at(-1)!, {
        words: 'It is my own print, bought from a mill.',
        signature: 'Sana Ahmed',
        sworn: true,
      });
      const [answer] = (await call('GET', '/rights-answers')).body.complaints;
      expect(answer).toMatchObject({
        id,
        counter: { words: 'It is my own print, bought from a mill.', status: 'open' },
      });
      expect(
        (await call('POST', `/rights/${id}/refuse-answer`, { answer: 'The mill is theirs' })).body,
      ).toMatchObject({ complaint: { counter: { status: 'refused', answeredBy: 'Bilal' } } });

      const released = await call('POST', `/rights/${id}/release`, {
        note: 'Gul Ahmed withdrew it',
      });
      expect(released.body).toMatchObject({
        complaint: { releasedBy: 'Bilal', releaseNote: 'Gul Ahmed withdrew it' },
        released: 1,
      });
      expect((await call('POST', `/rights/${id}/release`, { note: 'Again' })).status).toBe(409);
      expect((await told()).map((each) => each.kind)).toEqual([
        'listings_taken_down',
        'rights_counter_refused',
        'listings_released',
      ]);
    });

    it('clears a listing screening found by mistake', async () => {
      const products = new ProductService(database);
      const created = await products.create(tenant, { title: 'Shisha lawn suit' });
      if (!created.ok) throw new Error('no product');
      const id = toPublicId('product', created.value.id);
      expect((await call('POST', `/products/${id}/clear-screening`)).body).toEqual({
        product: { id, title: 'Shisha lawn suit', found: expect.any(Array) },
      });
      expect(
        (await call('POST', `/products/${toPublicId('product', newId())}/clear-screening`)).status,
      ).toBe(404);
    });

    it('clears a sign of a scam store found to be nothing', async () => {
      await admin.query(
        `INSERT INTO trust.store_signals (shop_id, kind, detail)
         VALUES ($1, 'prepaid_unshipped', '{"orders": 6}')`,
        [shop],
      );
      expect((await call('GET', '/signals')).body.signals).toEqual([
        expect.objectContaining({
          shop: { id: toPublicId('shop', shop), name: 'Zari', handle: 'zari' },
          kind: 'prepaid_unshipped',
          detail: { orders: 6 },
          clearedAt: null,
        }),
      ]);
      expect(
        (await call('POST', '/shops/zari/signals/prepaid_unshipped/clear', {})).body.error.fields,
      ).toEqual({ note: 'BLANK' });
      expect(
        (await call('POST', '/shops/zari/signals/prepaid_unshipped/clear', { note: 'Pre-orders' }))
          .body,
      ).toEqual({ cleared: true });
      expect((await call('GET', '/signals')).body.signals).toEqual([]);
      expect(
        (await call('POST', '/shops/zari/signals/prepaid_unshipped/clear', { note: 'Again' }))
          .status,
      ).toBe(404);
    });

    it("approves a shop's sender name once it is verified, and takes it back", async () => {
      const senders = new SmsSendersService(database);
      const asked = await senders.request(tenant, { name: 'ZARI' }, newId());
      if (!asked.ok) throw new Error('not asked');
      const id = toPublicId('smsSender', asked.value.id);
      expect((await call('GET', '/sms-senders')).body.senders).toEqual([
        expect.objectContaining({
          id,
          name: 'ZARI',
          status: 'waiting',
          shop: { handle: 'zari', id: toPublicId('shop', shop), name: 'Zari' },
        }),
      ]);
      expect((await call('POST', `/sms-senders/${id}/approve`, {})).body.error.code).toBe(
        'NOT_VERIFIED',
      );
      await admin.query(
        `INSERT INTO trust.verifications
         (shop_id, level, name, cnic_last4, status, asked_by, decided_at, decided_by)
         VALUES ($1, 'identity', 'Sana Ahmed', '5671', 'approved', $2, now(), 'Ayesha')`,
        [shop, newId()],
      );
      expect((await call('POST', `/sms-senders/${id}/approve`, {})).body.sender).toMatchObject({
        status: 'approved',
        decidedBy: 'Bilal',
      });
      expect((await call('POST', `/sms-senders/${id}/refuse`, { answer: 'No' })).status).toBe(409);
      expect(
        (await call('POST', '/shops/zari/sms-sender/revoke', { answer: 'Jazz took it back' })).body
          .sender,
      ).toMatchObject({ status: 'revoked', answer: 'Jazz took it back' });
      expect(
        (await call('POST', '/shops/zari/sms-sender/revoke', { answer: 'Again' })).body.error.code,
      ).toBe('NOT_APPROVED');
      expect((await told()).map((each) => each.kind).slice(-2)).toEqual([
        'sms_sender_approved',
        'sms_sender_revoked',
      ]);
      const log = (await call('GET', '/actions?first=100')).body.actions;
      expect(new Set(log.map((each: Json) => each.action))).toEqual(
        new Set([
          'rights.dismiss',
          'rights.uphold',
          'rights.refuse_answer',
          'rights.release',
          'product.clear_screening',
          'signal.clear',
          'sms_sender.approve',
          'sms_sender.refuse',
          'sms_sender.revoke',
        ]),
      );
    });
  },
);
