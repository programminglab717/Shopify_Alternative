import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import { MessagingSettingsService } from '@hatti/messaging/public';
import { AppealsService, ReportsService } from '@hatti/trust/public';
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
  "Hatti's console: shoppers' reports, takedowns, appeals and verifications (ADR-877)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let database: Database;
    let testConsole: TestConsole;
    let provider: Awaited<ReturnType<typeof fakeOidcProvider>>;
    let token = '';
    const shop = newId();

    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const response = await testConsole.app.inject({
        method,
        url: `/console/api${url}`,
        ...(payload && { payload }),
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.statusCode, body: response.json() as Json };
    };

    /** What the shop was told, of its store's standing. */
    const told = async () =>
      (
        await admin.query<{ kind: string; variables: Record<string, string> }>(
          `SELECT kind, variables FROM messaging.messages
          WHERE shop_id = $1 AND kind LIKE ANY (ARRAY['store_%', 'shop_verif%'])
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
        applicationName: 'console-trust-test',
      });
      const tenant: TenantContext = {
        shopId: shop,
        currency: 'PKR',
        actor: { kind: 'app', tokenId: newId() },
        scopes: new Set(['write_settings']),
      };
      await new MessagingSettingsService(database).update(tenant, { alertsPhone: '0333 5550009' });
      provider = await fakeOidcProvider(CLIENT);
      testConsole = await startTestConsole(testDb, {
        issuer: provider.issuer,
        clientId: CLIENT.id,
        clientSecret: CLIENT.secret,
        consoleUrl: 'https://console.hatti.example',
      });
      token = await consoleAgentToken(testConsole, admin, provider, 'ayesha@hatti.pk', 'Ayesha');
    });

    afterAll(async () => {
      await testConsole?.close();
      provider?.http.close();
      await database?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it("decides shoppers' reports, as the agent signed in", async () => {
      const taken = await new ReportsService(database).report(shop, {
        reason: 'never_delivered',
        details: 'Paid an advance of Rs 2,000 and nothing came.',
        orderName: '#1043',
        client: '203.0.113.9',
        language: 'en',
      });
      if (!taken.ok) throw new Error('not reported');
      const id = toPublicId('storeReport', taken.value.id);
      const open = await call('GET', '/reports');
      expect(open.body.reports).toEqual([
        expect.objectContaining({
          id,
          shop: { id: toPublicId('shop', shop), name: 'Zari', handle: 'zari' },
          reason: 'never_delivered',
          orderName: '#1043',
          status: 'open',
          overdue: false,
          openOfShop: 1,
        }),
      ]);
      expect(
        (await call('POST', `/reports/${id}/decide`, { status: 'upheld' })).body.error,
      ).toEqual({
        code: 'BLANK',
        message: 'Say what was done',
        fields: { note: 'BLANK' },
      });
      const upheld = await call('POST', `/reports/${id}/decide`, {
        status: 'upheld',
        note: 'Refunded through the courier',
      });
      expect(upheld.body.report).toMatchObject({
        status: 'upheld',
        decidedBy: 'Ayesha',
        decision: 'Refunded through the courier',
      });
      expect(
        (await call('POST', `/reports/${id}/decide`, { status: 'dismissed', note: 'x' })).status,
      ).toBe(409);
      expect((await call('GET', '/reports')).body.reports).toEqual([]);
      expect((await call('GET', '/reports?all=1')).body.reports).toHaveLength(1);
    });

    it('takes a store down with its owner told, refuses an appeal, and restores the store', async () => {
      expect(
        (await call('POST', '/shops/zari/suspend', { reason: 'rude', note: 'x' })).body.error
          .fields,
      ).toEqual({ reason: 'INVALID' });
      const note = 'Advances taken for orders never sent';
      const down = await call('POST', '/shops/zari/suspend', { reason: 'scam', note });
      expect(down.body.takedown).toMatchObject({
        shop: { handle: 'zari' },
        reason: 'scam',
        note,
        takenBy: 'Ayesha',
        restoredAt: null,
      });
      expect(
        (await admin.query('SELECT status FROM control.shops WHERE id = $1', [shop])).rows[0],
      ).toEqual({ status: 'suspended' });
      expect((await call('POST', '/shops/zari/suspend', { reason: 'scam', note })).status).toBe(
        409,
      );
      expect((await call('POST', '/shops/nobody/suspend', { reason: 'scam', note })).status).toBe(
        404,
      );
      expect((await call('GET', '/takedowns')).body.takedowns).toHaveLength(1);

      const [suspended] = await told();
      expect(suspended).toMatchObject({
        kind: 'store_suspended',
        variables: { shop: 'Zari', note },
      });
      const link = new URL(suspended!.variables.url!);
      expect(link.origin).toBe('https://hatti.example');
      const appealed = await new AppealsService(database).appeal(
        link.pathname.split('/').at(-1)!,
        'Every order was sent; I have the courier receipts.',
      );
      expect(appealed).not.toBeNull();
      const [waiting] = (await call('GET', '/appeals')).body.appeals;
      expect(waiting).toMatchObject({
        shop: { handle: 'zari' },
        words: 'Every order was sent; I have the courier receipts.',
        takedownNote: note,
        status: 'open',
      });
      expect((await call('POST', `/appeals/${waiting.id}/refuse`, { answer: ' ' })).status).toBe(
        422,
      );
      const refused = await call('POST', `/appeals/${waiting.id}/refuse`, {
        answer: 'The receipts are for other orders',
      });
      expect(refused.body.appeal).toMatchObject({ status: 'refused', answeredBy: 'Ayesha' });
      expect((await call('GET', '/appeals')).body.appeals).toEqual([]);

      const restored = await call('POST', '/shops/zari/restore', {
        note: 'Refunded every advance',
      });
      expect(restored.body.takedown).toMatchObject({
        restoredBy: 'Ayesha',
        restoreNote: 'Refunded every advance',
      });
      expect((await call('POST', '/shops/zari/restore', { note: 'Again' })).status).toBe(409);
      expect((await told()).map((each) => each.kind)).toEqual([
        'store_suspended',
        'store_appeal_refused',
        'store_restored',
      ]);
    });

    it("shows a verification's documents to an agent who asks, logged, and decides it", async () => {
      const key = `shops/${shop}/verifications/cnic-front.png`;
      await testConsole.storage.put(key, Buffer.from('a CNIC photo'), 'image/png');
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO trust.verifications (shop_id, level, name, cnic, cnic_last4, documents, asked_by)
       VALUES ($1, 'identity', 'Sana Ahmed', '3520212345671', '5671', $2, $3) RETURNING id`,
        [shop, JSON.stringify([{ key, contentType: 'image/png', size: 12 }]), newId()],
      );
      const id = toPublicId('verification', rows[0]!.id);
      const [waiting] = (await call('GET', '/verifications')).body.verifications;
      expect(waiting).toMatchObject({
        id,
        level: 'identity',
        name: 'Sana Ahmed',
        cnic: '3520212345671',
        documents: 1,
        status: 'waiting',
      });
      const links = (await call('GET', `/verifications/${id}/documents`)).body.links as string[];
      expect(links).toHaveLength(1);
      expect(links[0]).toMatch(/^http:\/\/localhost:4000\/storage\//);

      expect((await call('POST', `/verifications/${id}/refuse`, {})).body.error.fields).toEqual({
        answer: 'BLANK',
      });
      const approved = await call('POST', `/verifications/${id}/approve`, {});
      expect(approved.body.verification).toMatchObject({
        status: 'approved',
        decidedBy: 'Ayesha',
        cnic: null,
        documents: 0,
      });
      expect((await call('POST', `/verifications/${id}/approve`, {})).status).toBe(409);
      expect((await call('GET', `/verifications/${id}/documents`)).status).toBe(404);

      expect(
        (await call('POST', '/shops/zari/unverify', { level: 'identity', answer: 'Forged CNIC' }))
          .body.verifications,
      ).toEqual([expect.objectContaining({ id, status: 'revoked', answer: 'Forged CNIC' })]);
      expect(
        (await call('POST', '/shops/zari/unverify', { level: 'identity', answer: 'Again' })).status,
      ).toBe(409);
      expect((await told()).map((each) => each.kind).slice(-2)).toEqual([
        'shop_verified',
        'shop_verification_revoked',
      ]);
    });

    it('logs each thing done, by whom, before it was done', async () => {
      const { actions } = (await call('GET', '/actions')).body;
      expect(
        actions
          .map((each: Json) => [each.email, each.action])
          .reverse()
          .filter(([, action]: string[]) => action !== 'support_request.answer'),
      ).toEqual(
        [
          'report.uphold',
          'report.dismiss',
          'store.suspend',
          'store.suspend',
          'store.suspend',
          'appeal.refuse',
          'store.restore',
          'store.restore',
          'verification.documents',
          'verification.approve',
          'verification.approve',
          'verification.revoke',
          'verification.revoke',
        ].map((action) => ['ayesha@hatti.pk', action]),
      );
    });
  },
);
