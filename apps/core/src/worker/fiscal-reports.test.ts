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
  FbrPosClient,
  FbrPosService,
  FiscalInvoicesService,
  recordFiscalDocumentsIn,
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

describe.skipIf(!server)("Tier-1 shops' invoices reported to FBR (POS-04, ADR-555)", () => {
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
});
