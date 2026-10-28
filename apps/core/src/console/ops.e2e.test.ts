import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
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
  "Hatti's console: transfers into Hatti's account, and the status page (ADR-879)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
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

    /** A transfer the shop's owner said they made for its open invoice of Rs 2,999. */
    async function transferSaid(reference: string): Promise<string> {
      const open = await admin.query<{ id: string }>(
        `SELECT id FROM billing.invoices WHERE shop_id = $1 AND status = 'open'`,
        [shop],
      );
      const { rows: invoices } =
        open.rows.length > 0
          ? open
          : await admin.query<{ id: string }>(
              `INSERT INTO billing.invoices (shop_id, reason, plan, billing_interval, price)
             VALUES ($1, 'change', 'growth', 'monthly', 299900) RETURNING id`,
              [shop],
            );
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO billing.payments
         (shop_id, invoice_id, gateway, environment, amount, transfer_reference)
       VALUES ($1, $2, 'bank_transfer', 'production', 299900, $3) RETURNING id`,
        [shop, invoices[0]!.id, reference],
      );
      return toPublicId('billingTransfer', rows[0]!.id);
    }

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`,
        [shop],
      );
      provider = await fakeOidcProvider(CLIENT);
      testConsole = await startTestConsole(testDb, {
        issuer: provider.issuer,
        clientId: CLIENT.id,
        clientSecret: CLIENT.secret,
        consoleUrl: 'https://console.hatti.example',
      });
      token = await consoleAgentToken(testConsole, admin, provider, 'omar@hatti.pk', 'Omar');
    });

    afterAll(async () => {
      await testConsole?.close();
      provider?.http.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('confirms a transfer found short of its invoice, and refuses one not found', async () => {
      const first = await transferSaid('FT24100012');
      expect((await call('GET', '/billing-transfers')).body.transfers).toEqual([
        {
          id: first,
          shop: { id: toPublicId('shop', shop), name: 'Zari' },
          invoiceName: expect.stringMatching(/^HB-\d+$/),
          reference: 'FT24100012',
          amount: 'Rs 2,999',
          reportedAt: expect.any(String),
        },
      ]);
      expect(
        (await call('POST', `/billing-transfers/${first}/confirm`, { received: 'nothing' })).body
          .error.fields,
      ).toEqual({ received: 'INVALID' });
      expect(
        (await call('POST', `/billing-transfers/${first}/confirm`, { received: '2,000' })).body,
      ).toEqual({
        transfer: { outcome: 'short', invoiceName: expect.any(String), left: 'Rs 999' },
      });
      expect((await call('POST', `/billing-transfers/${first}/confirm`, {})).status).toBe(409);
      expect(
        (
          await admin.query(
            'SELECT status, checked_by FROM billing.payments WHERE transfer_reference = $1',
            ['FT24100012'],
          )
        ).rows[0],
      ).toEqual({ status: 'paid', checked_by: 'Omar' });

      const second = await transferSaid('FT24100099');
      expect(
        (await call('POST', `/billing-transfers/${second}/refuse`, {})).body.error.fields,
      ).toEqual({
        reason: 'BLANK',
      });
      expect(
        (
          await call('POST', `/billing-transfers/${second}/refuse`, {
            reason: 'Not in the account',
          })
        ).body.transfer.outcome,
      ).toBe('refused');
      expect((await call('GET', '/billing-transfers')).body.transfers).toEqual([]);
    });

    it("matches transfers waiting from Hatti's bank statement, confirming none itself (ADR-883)", async () => {
      const id = await transferSaid('FT24100777');
      expect((await call('POST', '/billing-transfers/statement', { csv: ' ' })).status).toBe(422);
      expect(
        (await call('POST', '/billing-transfers/statement', { csv: 'Date,Amount\n1,2' })).body.error
          .message,
      ).toMatch(/No column of credits/);
      const csv = [
        'Txn Date,Narration,Debit,Credit',
        '05-11-2026,IBFT FROM SANA REF FT-2410-0777,,"2,999.00"',
        '05-11-2026,CASH DEPOSIT,,"10,000.00"',
      ].join('\n');
      const matched = (await call('POST', '/billing-transfers/statement', { csv })).body;
      expect(matched).toEqual({
        credits: 2,
        matches: [
          {
            transfer: expect.objectContaining({ id, reference: 'FT24100777' }),
            credit: {
              row: 2,
              date: '05-11-2026',
              description: 'IBFT FROM SANA REF FT-2410-0777',
              amount: 'Rs 2,999',
              received: '2999.00',
            },
            outcome: 'exact',
          },
        ],
        ambiguous: [],
        unmatched: [expect.objectContaining({ description: 'CASH DEPOSIT', amount: 'Rs 10,000' })],
        moreUnmatched: 0,
      });
      // Nothing was confirmed: it waits until Hatti's people confirm it.
      expect((await call('GET', '/billing-transfers')).body.transfers).toHaveLength(1);
      expect(
        (await call('POST', `/billing-transfers/${id}/confirm`, { received: '2999.00' })).body
          .transfer.outcome,
        // With the Rs 2,000 found before, the invoice is paid.
      ).toBe('paid');
    });

    it('posts an incident to the status page, updates it, and ends it', async () => {
      expect(
        (await call('POST', '/incidents', { kind: 'outage', impact: 'degraded' })).body.error
          .fields,
      ).toEqual({ kind: 'INVALID' });
      expect(
        (
          await call('POST', '/incidents', {
            kind: 'incident',
            impact: 'degraded',
            components: ['couriers'],
            title: 'PostEx bookings failing',
            body: 'Bookings with PostEx fail; we are on it.',
            startsAt: '2026-11-01T02:00:00Z',
          })
        ).body.error.message,
      ).toBe('An incident begins as it is posted: only maintenance has times.');
      const opened = await call('POST', '/incidents', {
        kind: 'incident',
        impact: 'degraded',
        components: ['couriers'],
        title: 'PostEx bookings failing',
        titleUr: 'پوسٹ ایکس کی بکنگ نہیں ہو رہی',
        body: 'Bookings with PostEx fail; we are on it.',
      });
      expect(opened.body.incident).toMatchObject({
        id: expect.stringMatching(/^inc_/),
        kind: 'incident',
        impact: 'degraded',
        components: ['couriers'],
        status: 'investigating',
        createdBy: 'Omar',
        resolvedAt: null,
      });
      const id = opened.body.incident.id as string;
      expect((await call('GET', '/incidents')).body.incidents).toHaveLength(1);
      const identified = await call('POST', `/incidents/${id}/update`, {
        status: 'identified',
        body: "PostEx's API is down; bookings go through once it is back.",
        impact: 'outage',
      });
      expect(identified.body.incident).toMatchObject({ status: 'identified', impact: 'outage' });
      const resolved = await call('POST', `/incidents/${id}/update`, {
        status: 'resolved',
        body: 'Bookings go through again.',
      });
      expect(resolved.body.incident.resolvedAt).not.toBeNull();
      expect(
        resolved.body.incident.updates.map((each: Json) => [each.status, each.postedBy]),
      ).toEqual([
        ['investigating', 'Omar'],
        ['identified', 'Omar'],
        ['resolved', 'Omar'],
      ]);
      expect(
        (
          await call('POST', `/incidents/${toPublicId('incident', newId())}/update`, {
            status: 'resolved',
            body: 'x',
          })
        ).status,
      ).toBe(404);
      const log = (await call('GET', '/actions')).body.actions.map((each: Json) => each.action);
      expect(log.filter((each: string) => each.startsWith('incident.'))).toEqual([
        'incident.update',
        'incident.update',
        'incident.update',
        'incident.open',
        'incident.open',
      ]);
    });
  },
);
