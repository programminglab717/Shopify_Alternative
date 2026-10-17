import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import {
  FbrDigitalInvoicingClient,
  FbrPosClient,
  FbrPosService,
  FiscalInvoicesService,
  recordFiscalDocumentsIn,
  type DiInvoiceRequest,
  type FiscalDocument,
} from '@hatti/tax/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FISCAL_GIVE_UP_MS, FiscalReporter, fiscalRetryDelayMs } from './fiscal-reports.js';

const server = testDatabaseServer();

function invoice(usin: string): FiscalDocument {
  return {
    kind: 'invoice',
    usin,
    orderId: newId(),
    refUsin: null,
    issuedAt: new Date(),
    paymentMode: 'cash',
    items: [
      {
        code: 'KURTA',
        name: 'Kurta',
        quantity: 1,
        total: 2_000_00n,
        tax: 305_08n,
        rate: 1800,
        discount: 0n,
      },
    ],
  };
}

describe.skipIf(!server)(
  "Shops' invoices reported to FBR (POS-04, TAX-04, ADR-555, ADR-562)",
  () => {
    let testDb: TestDatabase;
    let db: Database;
    let admin: pg.Client;
    let fbr: Server;
    let base: string;
    const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
    const shopId = newId();
    const tenant: TenantContext = {
      shopId,
      currency: 'PKR',
      actor: { kind: 'app', tokenId: newId() },
      scopes: new Set(['write_settings']),
    };
    /** What FBR says of each USIN: its number, a refusal, or that it is down. */
    const answers = new Map<string, 'refuse' | 'down'>();
    const received: { posId: number; usin: string; pct: string; auth: string }[] = [];
    /** What digital invoicing was sent: its buyer names the invoice, as it has no USIN. */
    const digital: { url: string; buyer: string; scenario?: string; hs: string; auth: string }[] =
      [];

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      db = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'fiscal-reports-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shopId]);
      fbr = createServer((request, response) => {
        let text = '';
        request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        request.on('end', () => {
          if (request.url?.startsWith('/di')) {
            const sent = JSON.parse(text) as DiInvoiceRequest;
            digital.push({
              url: request.url,
              buyer: sent.buyerBusinessName,
              scenario: sent.scenarioId,
              hs: sent.items[0]!.hsCode,
              auth: request.headers.authorization ?? '',
            });
            const refused = answers.get(sent.buyerBusinessName) === 'refuse';
            const item = refused
              ? {
                  itemSNo: '1',
                  statusCode: '01',
                  errorCode: '0052',
                  error: 'Provide proper HS Code',
                }
              : { itemSNo: '1', statusCode: '00', errorCode: '', error: '' };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                invoiceNumber: `7000007DI${digital.length}`,
                dated: '2026-10-17 14:05:09',
                validationResponse: {
                  statusCode: '00',
                  status: 'Valid',
                  error: '',
                  invoiceStatuses: [item],
                },
              }),
            );
            return;
          }
          const body = JSON.parse(text) as {
            POSID: number;
            USIN: string;
            Items: { PCTCode: string }[];
          };
          received.push({
            posId: body.POSID,
            usin: body.USIN,
            pct: body.Items[0]!.PCTCode,
            auth: request.headers.authorization ?? '',
          });
          const answer = answers.get(body.USIN);
          if (answer === 'down') {
            response.writeHead(503).end('down');
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify(
              answer === 'refuse'
                ? { InvoiceNumber: '', Code: '102', Response: 'Invalid PCT code', Errors: null }
                : { InvoiceNumber: `FBR-${body.USIN}`, Code: '100', Response: 'OK', Errors: null },
            ),
          );
        });
      });
      await new Promise<void>((resolve) => fbr.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(fbr.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => fbr?.close(resolve));
      await db?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('reports each from the POS the shop connected, settles it as FBR answered, and tries again later when FBR is down', async () => {
      const pos = new FbrPosService(db, box);
      const fiscal = new FiscalInvoicesService(db);
      const reporter = new FiscalReporter({
        fiscal,
        pos,
        client: new FbrPosClient({ productionUrl: `${base}/live`, sandboxUrl: `${base}/sandbox` }),
        digitalInvoicing: new FbrDigitalInvoicingClient({
          productionUrl: `${base}/di`,
          sandboxUrl: `${base}/di_sb`,
        }),
      });
      const connected = await pos.update(tenant, {
        posId: 123456,
        accessToken: '1298b5eb-b252-3d97-8622-a4a69d5bf818',
        environment: 'production',
        pctCode: '6204.4200',
      });
      expect(connected.ok).toBe(true);
      await db.tenant(shopId, (tx) =>
        recordFiscalDocumentsIn(
          tx,
          shopId,
          ['INV/2026-27/00001', 'INV/2026-27/00002', 'INV/2026-27/00003'].map(invoice),
          'Asia/Karachi',
        ),
      );
      answers.set('INV/2026-27/00002', 'refuse');
      answers.set('INV/2026-27/00003', 'down');

      const at = new Date(Date.now() + 1_000);
      expect(await reporter.sweep(at)).toBe(1);
      expect(received).toEqual(
        ['INV/2026-27/00001', 'INV/2026-27/00002', 'INV/2026-27/00003'].map((usin) => ({
          posId: 123456,
          usin,
          pct: '62044200',
          auth: 'Bearer 1298b5eb-b252-3d97-8622-a4a69d5bf818',
        })),
      );
      const byUsin = async () =>
        new Map((await fiscal.list(tenant)).map((each) => [each.usin, each]));
      let states = await byUsin();
      expect(states.get('INV/2026-27/00001')).toMatchObject({
        status: 'reported',
        fbrInvoiceNumber: 'FBR-INV/2026-27/00001',
      });
      expect(states.get('INV/2026-27/00002')).toMatchObject({
        status: 'failed',
        error: 'FBR refused it (code 102): Invalid PCT code',
      });
      expect(states.get('INV/2026-27/00003')).toMatchObject({
        status: 'pending',
        attempts: 1,
        error: 'FBR 503: down',
      });

      // Not due again until its wait is over; then FBR, up again, takes it.
      expect(await reporter.sweep(new Date(at.getTime() + 30_000))).toBe(0);
      answers.delete('INV/2026-27/00003');
      expect(await reporter.sweep(new Date(at.getTime() + fiscalRetryDelayMs(1) + 1))).toBe(1);
      states = await byUsin();
      expect(states.get('INV/2026-27/00003')).toMatchObject({ status: 'reported', attempts: 2 });
      expect(received).toHaveLength(4);

      // A week of FBR down, and it is given up as failed.
      await db.tenant(shopId, (tx) =>
        recordFiscalDocumentsIn(tx, shopId, [invoice('INV/2026-27/00004')], 'Asia/Karachi'),
      );
      answers.set('INV/2026-27/00004', 'down');
      const late = new Date(Date.now() + FISCAL_GIVE_UP_MS + 60_000);
      expect(await reporter.sweep(late)).toBe(0);
      expect((await byUsin()).get('INV/2026-27/00004')).toMatchObject({
        status: 'failed',
        error: 'FBR 503: down',
      });

      // Waits double, up to six hours.
      expect([1, 2, 3, 20].map(fiscalRetryDelayMs)).toEqual([60_000, 120_000, 240_000, 21_600_000]);
    });

    it('reports invoices through digital invoicing for a shop registered for sales tax, and none kept for the POS (ADR-562)', async () => {
      const pos = new FbrPosService(db, box);
      const fiscal = new FiscalInvoicesService(db);
      const reporter = new FiscalReporter({
        fiscal,
        pos,
        client: new FbrPosClient({ productionUrl: `${base}/live`, sandboxUrl: `${base}/sandbox` }),
        digitalInvoicing: new FbrDigitalInvoicingClient({
          productionUrl: `${base}/di`,
          sandboxUrl: `${base}/di_sb`,
        }),
      });
      // One kept for the POS before the shop switched, waiting still.
      await db.tenant(shopId, (tx) =>
        recordFiscalDocumentsIn(tx, shopId, [invoice('INV/2026-27/00005')], 'Asia/Karachi'),
      );
      await admin.query(
        `INSERT INTO tax.settings (shop_id, ntn, strn, province)
       VALUES ($1, '1234567-8', '3277876175852', 'sindh')`,
        [shopId],
      );
      const switched = await pos.update(tenant, {
        system: 'digital_invoicing',
        accessToken: 'a7c3e9f1-0d5b-4c2e-9b8a-6f4d2e1c0b9a',
        environment: 'sandbox',
      });
      expect(switched.ok).toBe(true);
      await admin.query(
        `UPDATE tax.fiscal_invoices SET status = 'pending', error = NULL
        WHERE shop_id = $1 AND usin = 'INV/2026-27/00005'`,
        [shopId],
      );
      const sold = (usin: string): FiscalDocument => ({
        ...invoice(usin),
        buyer: { name: usin, address: 'House 12, Street 4, Karachi', province: 'SD' },
      });
      await db.tenant(shopId, (tx) =>
        recordFiscalDocumentsIn(
          tx,
          shopId,
          [sold('INV/2026-27/00006'), sold('INV/2026-27/00007')],
          'Asia/Karachi',
        ),
      );
      answers.set('INV/2026-27/00007', 'refuse');

      const posSent = received.length;
      expect(await reporter.sweep(new Date(Date.now() + 1_000))).toBe(1);
      expect(received).toHaveLength(posSent);
      expect(digital).toEqual(
        ['INV/2026-27/00006', 'INV/2026-27/00007'].map((buyer) => ({
          url: '/di_sb',
          buyer,
          scenario: 'SN002',
          hs: '6204.4200',
          auth: 'Bearer a7c3e9f1-0d5b-4c2e-9b8a-6f4d2e1c0b9a',
        })),
      );
      const states = new Map((await fiscal.list(tenant)).map((each) => [each.usin, each]));
      expect(states.get('INV/2026-27/00005')).toMatchObject({
        system: 'pos',
        status: 'skipped',
        error: "Not reported: the shop now reports through FBR's digital invoicing",
      });
      expect(states.get('INV/2026-27/00006')).toMatchObject({
        system: 'digital_invoicing',
        status: 'reported',
        fbrInvoiceNumber: '7000007DI1',
      });
      expect(states.get('INV/2026-27/00007')).toMatchObject({
        status: 'failed',
        error: 'FBR refused it (code 00): item 1: Provide proper HS Code (0052)',
      });
    });
  },
);
