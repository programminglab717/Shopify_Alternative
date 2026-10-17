import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlanAllowance, type MutationResult, type TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FbrPosClient, type FbrPosConnection } from './fbr-client.js';
import {
  FbrPosService,
  FiscalInvoicesService,
  fiscalInvoicesIn,
  recordFiscalDocumentsIn,
} from './fbr-pos.service.js';
import {
  fbrDateTime,
  fbrInvoiceBody,
  fbrInvoiceRequest,
  pctCodeOf,
  type FiscalDocument,
} from './fbr.js';
import { fbrPos, fiscalInvoices } from './schema.js';

const ISSUED = new Date('2026-10-17T09:05:09Z');

/** Rs 2,000 of lawn at 18%, Rs 500 off it, and Rs 250 delivery with its tax. */
const INVOICE: FiscalDocument = {
  kind: 'invoice',
  usin: 'INV/2026-27/00001',
  orderId: '00000000-0000-4000-8000-000000000001',
  refUsin: null,
  issuedAt: ISSUED,
  paymentMode: 'cash',
  items: [
    {
      code: 'LAWN-3PC',
      name: 'Lawn suit - Blue',
      quantity: 2,
      total: 1_500_00n,
      tax: 228_81n,
      rate: 1800,
      discount: 500_00n,
    },
    {
      code: 'DELIVERY',
      name: 'Delivery',
      quantity: 1,
      total: 250_00n,
      tax: 38_14n,
      rate: 1800,
      discount: 0n,
    },
  ],
};

describe('What FBR is sent of an invoice (POS-04, ADR-555)', () => {
  it("adds its totals up from its items, in rupees, at the time in the shop's zone", () => {
    const body = fbrInvoiceBody(INVOICE, 'Asia/Karachi');
    expect(body).toEqual({
      InvoiceNumber: '',
      USIN: 'INV/2026-27/00001',
      DateTime: '2026-10-17 14:05:09',
      TotalBillAmount: 1750,
      TotalQuantity: 3,
      TotalSaleValue: 1483.05,
      TotalTaxCharged: 266.95,
      Discount: 500,
      FurtherTax: 0,
      PaymentMode: 1,
      InvoiceType: 1,
      RefUSIN: null,
      Items: [
        {
          ItemCode: 'LAWN-3PC',
          ItemName: 'Lawn suit - Blue',
          Quantity: 2,
          TaxRate: 18,
          SaleValue: 1271.19,
          TotalAmount: 1500,
          TaxCharged: 228.81,
          Discount: 500,
          FurtherTax: 0,
          InvoiceType: 1,
          RefUSIN: null,
        },
        {
          ItemCode: 'DELIVERY',
          ItemName: 'Delivery',
          Quantity: 1,
          TaxRate: 18,
          SaleValue: 211.86,
          TotalAmount: 250,
          TaxCharged: 38.14,
          Discount: 0,
          FurtherTax: 0,
          InvoiceType: 1,
          RefUSIN: null,
        },
      ],
    });
    // The POS and its PCT code go in as the shop reports it.
    const request = fbrInvoiceRequest(body, 123456, '62044200');
    expect(request.POSID).toBe(123456);
    expect(request.Items.map((item) => item.PCTCode)).toEqual(['62044200', '62044200']);
    expect(fbrDateTime(new Date('2026-12-31T19:30:00Z'), 'Asia/Karachi')).toBe(
      '2027-01-01 00:30:00',
    );
  });

  it("sends a credit note as FBR's credit invoice, naming the invoice it corrects", () => {
    const body = fbrInvoiceBody(
      {
        kind: 'credit_note',
        usin: 'CN/2026-27/00001',
        orderId: INVOICE.orderId,
        refUsin: 'INV/2026-27/00001',
        issuedAt: ISSUED,
        paymentMode: 'card',
        items: [
          {
            code: 'REFUND',
            name: 'Refund',
            quantity: 1,
            total: 500_00n,
            tax: 0n,
            rate: null,
            discount: 0n,
          },
        ],
      },
      'Asia/Karachi',
    );
    expect(body).toMatchObject({
      USIN: 'CN/2026-27/00001',
      InvoiceType: 3,
      RefUSIN: 'INV/2026-27/00001',
      PaymentMode: 2,
      TotalBillAmount: 500,
      Items: [{ TaxRate: 0, InvoiceType: 3, RefUSIN: 'INV/2026-27/00001' }],
    });
  });

  it('takes PCT codes as the tariff writes them', () => {
    expect(pctCodeOf('6204.4200')).toBe('62044200');
    expect(pctCodeOf(' 62044200 ')).toBe('62044200');
    expect(pctCodeOf('6204.42')).toBeNull();
    expect(pctCodeOf('620442OO')).toBeNull();
  });
});

describe("FBR's IMS as the client reports to it", () => {
  let server: Server;
  let base: string;
  let answer: { status: number; body: string };
  const seen: { url: string; headers: IncomingHttpHeaders; body: unknown }[] = [];
  const connection = (environment: 'sandbox' | 'production'): FbrPosConnection => ({
    posId: 123456,
    accessToken: '1298b5eb-b252-3d97-8622-a4a69d5bf818',
    environment,
    pctCode: '62044200',
  });

  beforeAll(async () => {
    server = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        seen.push({ url: request.url ?? '', headers: request.headers, body: JSON.parse(text) });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('gives the number FBR gave, and says why when FBR refuses, or cannot be reached', async () => {
    const client = new FbrPosClient({
      productionUrl: `${base}/live`,
      sandboxUrl: `${base}/sandbox`,
    });
    const request = fbrInvoiceRequest(fbrInvoiceBody(INVOICE, 'Asia/Karachi'), 123456, '62044200');
    answer = {
      status: 200,
      body: JSON.stringify({
        InvoiceNumber: '123456ZZZZ17102026140509001',
        Code: '100',
        Response: 'Fiscal Invoice Number generated successfully.',
        Errors: null,
      }),
    };
    expect(await client.report(connection('production'), request)).toEqual({
      ok: true,
      invoiceNumber: '123456ZZZZ17102026140509001',
    });
    expect(seen.at(-1)).toMatchObject({
      url: '/live',
      headers: { authorization: 'Bearer 1298b5eb-b252-3d97-8622-a4a69d5bf818' },
      body: { POSID: 123456, USIN: 'INV/2026-27/00001' },
    });
    await client.report(connection('sandbox'), request);
    expect(seen.at(-1)?.url).toBe('/sandbox');

    answer = {
      status: 200,
      body: JSON.stringify({
        InvoiceNumber: 'Not Available',
        Code: '102',
        Response: 'Invoice not received',
        Errors: 'POSID is not registered',
      }),
    };
    expect(await client.report(connection('production'), request)).toEqual({
      ok: false,
      retry: false,
      message: 'FBR refused it (code 102): Invoice not received: POSID is not registered',
    });
    // A token refused may be put right; FBR down is tried again.
    answer = { status: 401, body: '' };
    expect(await client.report(connection('production'), request)).toMatchObject({
      ok: false,
      retry: true,
      message: "FBR refused the POS's access token (401)",
    });
    answer = { status: 503, body: 'down' };
    expect(await client.report(connection('production'), request)).toEqual({
      ok: false,
      retry: true,
      message: 'FBR 503: down',
    });
    const gone = new FbrPosClient({ productionUrl: 'http://127.0.0.1:1/', sandboxUrl: base });
    expect(await gone.report(connection('production'), request)).toMatchObject({
      ok: false,
      retry: true,
    });
  });
});

/** Growth: no FBR connectors (ADR-555). */
class Growth extends PlanAllowance {
  async limitOf(): Promise<null> {
    return null;
  }

  async limitIn(): Promise<null> {
    return null;
  }

  async excludes(_shopId: string, feature: string): Promise<string | null> {
    return feature === 'fiscalReporting' ? 'Growth' : null;
  }
}

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_settings']),
  };
}

const TOKEN = '1298b5eb-b252-3d97-8622-a4a69d5bf818';
const dbServer = testDatabaseServer();

describe.skipIf(!dbServer)("A shop's POS connected to FBR, and its invoices reported", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let pos: FbrPosService;
  let fiscal: FiscalInvoicesService;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  const a = tenant(newId());
  const b = tenant(newId());

  const record = (shopId: string, documents: FiscalDocument[]) =>
    db.tenant(shopId, (tx) => recordFiscalDocumentsIn(tx, shopId, documents, 'Asia/Karachi'));

  beforeAll(async () => {
    testDb = await createTestDatabase(dbServer!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'fbr-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    pos = new FbrPosService(db, box);
    fiscal = new FiscalInvoicesService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM tax.fiscal_invoices');
    await admin.query('DELETE FROM tax.fbr_pos');
  });

  it('connects with all FBR gave, sealing the token, audited, and changes what is given', async () => {
    const errors = async (input: Parameters<FbrPosService['update']>[1]) => {
      const result = await pos.update(a, input);
      return result.ok ? [] : result.errors.map((error) => [error.field.join('.'), error.code]);
    };
    expect(await errors({ posId: 123456, accessToken: TOKEN, environment: 'production' })).toEqual([
      ['input.pctCode', 'BLANK'],
    ]);
    expect(
      await errors({
        posId: 0,
        accessToken: 'short',
        environment: 'test' as 'sandbox',
        pctCode: '62',
      }),
    ).toEqual([
      ['input.posId', 'INVALID'],
      ['input.accessToken', 'INVALID'],
      ['input.environment', 'INVALID'],
      ['input.pctCode', 'INVALID'],
    ]);
    // A plan without FBR's connectors connects none.
    const growth = new FbrPosService(db, box, new Growth());
    expect(
      await growth.update(a, {
        posId: 123456,
        accessToken: TOKEN,
        environment: 'production',
        pctCode: '6204.4200',
      }),
    ).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining('Growth plan') }] });

    const connected = unwrap(
      await pos.update(a, {
        posId: 123456,
        accessToken: ` ${TOKEN} `,
        environment: 'production',
        pctCode: '6204.4200',
      }),
    );
    expect(connected).toMatchObject({
      posId: 123456,
      tokenHint: 'f818',
      environment: 'production',
      pctCode: '62044200',
    });
    const { rows } = await admin.query<{ access_token: string }>(
      'SELECT access_token FROM tax.fbr_pos WHERE shop_id = $1',
      [a.shopId],
    );
    expect(rows[0]!.access_token).not.toContain(TOKEN);
    expect(await pos.connectionOf(a.shopId)).toEqual({
      posId: 123456,
      accessToken: TOKEN,
      environment: 'production',
      pctCode: '62044200',
    });
    // Changed in part; nothing changed is nothing recorded.
    unwrap(await pos.update(a, { environment: 'sandbox' }));
    unwrap(await pos.update(a, { environment: 'sandbox', accessToken: TOKEN }));
    const { rows: audit } = await admin.query<{ details: { changed: string[] } }>(
      `SELECT details FROM platform.audit_log WHERE shop_id = $1 AND action = 'fbr_pos.updated'
        ORDER BY id`,
      [a.shopId],
    );
    expect(audit.map((entry) => entry.details.changed)).toEqual([
      ['posId', 'accessToken', 'environment', 'pctCode'],
      ['environment'],
    ]);
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    expect(await pos.get(b)).toBeNull();
    await db.tenant(a.shopId, (tx) => tx.select().from(fbrPos).limit(1));
    await db.tenant(a.shopId, (tx) => tx.select().from(fiscalInvoices).limit(1));
  });

  it('keeps the invoices issued while connected, once each, reports them, and has a refused one sent again', async () => {
    // Nothing is kept for a shop not connected.
    expect(await record(a.shopId, [INVOICE])).toBe(0);
    unwrap(
      await pos.update(a, {
        posId: 123456,
        accessToken: TOKEN,
        environment: 'production',
        pctCode: '62044200',
      }),
    );
    const second = { ...INVOICE, usin: 'INV/2026-27/00002' };
    expect(await record(a.shopId, [INVOICE, second])).toBe(2);
    expect(await record(a.shopId, [INVOICE])).toBe(0);

    const at = new Date(Date.now() + 1_000);
    expect(await fiscal.dueShops(at)).toEqual([a.shopId]);
    const claimed = await fiscal.claim(a.shopId, at, 10, 60_000);
    expect(claimed.map((each) => [each.usin, each.attempts])).toEqual([
      ['INV/2026-27/00001', 1],
      ['INV/2026-27/00002', 1],
    ]);
    expect(claimed[0]!.body).toMatchObject({ USIN: 'INV/2026-27/00001', TotalBillAmount: 1750 });
    // Taken, they are not taken again until their lease ends.
    expect(await fiscal.claim(a.shopId, at, 10, 60_000)).toEqual([]);
    await fiscal.settle(
      a.shopId,
      [
        { id: claimed[0]!.id, status: 'reported', invoiceNumber: '123456ZZZZ001' },
        { id: claimed[1]!.id, status: 'failed', error: 'FBR refused it (code 102): bad PCT' },
      ],
      at,
    );
    const listed = await fiscal.list(a);
    expect(listed.map((each) => [each.usin, each.status, each.fbrInvoiceNumber])).toEqual(
      expect.arrayContaining([
        ['INV/2026-27/00001', 'reported', '123456ZZZZ001'],
        ['INV/2026-27/00002', 'failed', null],
      ]),
    );
    expect((await fiscal.list(a, { status: 'failed' })).map((each) => each.usin)).toEqual([
      'INV/2026-27/00002',
    ]);
    const found = await db.tenant(a.shopId, (tx) =>
      fiscalInvoicesIn(tx, a.shopId, ['INV/2026-27/00001', 'INV/2026-27/00003']),
    );
    expect([...found.keys()]).toEqual(['INV/2026-27/00001']);

    // A refused one goes again; a reported one does not, nor another shop's.
    const failed = listed.find((each) => each.status === 'failed')!;
    const reported = listed.find((each) => each.status === 'reported')!;
    expect(unwrap(await fiscal.retry(a, failed.id))).toMatchObject({ status: 'pending' });
    expect(await fiscal.retry(a, reported.id)).toMatchObject({
      ok: false,
      errors: [{ code: 'INVALID' }],
    });
    expect(await fiscal.retry(b, failed.id)).toMatchObject({
      ok: false,
      errors: [{ code: 'NOT_FOUND' }],
    });
    expect(await fiscal.list(b)).toEqual([]);

    // Disconnecting leaves what waits unsent.
    expect(await pos.delete(a)).toBe(123456);
    expect(await pos.delete(a)).toBeNull();
    expect((await fiscal.list(a, { status: 'skipped' })).map((each) => each.usin)).toEqual([
      'INV/2026-27/00002',
    ]);
    expect(await fiscal.retry(a, failed.id)).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining('Connect') }],
    });
  });
});
