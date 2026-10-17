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
import { FbrDigitalInvoicingClient } from './fbr-di-client.js';
import {
  DI_NO_CREDIT_NOTES,
  diInvoiceBody,
  diInvoiceRequest,
  diProvinceOf,
  type DiInvoiceBody,
  type DiSeller,
} from './fbr-di.js';
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
const TOKEN = '1298b5eb-b252-3d97-8622-a4a69d5bf818';

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
    // An item with a PCT code of its own keeps it (ADR-557).
    const own = fbrInvoiceBody(
      { ...INVOICE, items: [{ ...INVOICE.items[0]!, pctCode: '62034200' }, INVOICE.items[1]!] },
      'Asia/Karachi',
    );
    expect(own.Items[0]!.PCTCode).toBe('62034200');
    expect(fbrInvoiceRequest(own, 123456, '62044200').Items.map((item) => item.PCTCode)).toEqual([
      '62034200',
      '62044200',
    ]);
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

/** The seller, as its tax settings and the shop directory have it. */
const SELLER: DiSeller = { ntn: '1234567-8', businessName: 'Zari', province: 'punjab' };

/** The lawn invoice, sold from Lahore to a customer in Karachi. */
const SOLD: FiscalDocument = {
  ...INVOICE,
  buyer: {
    name: 'Ayesha Khan',
    address: 'House 12, Street 4, Gulshan-e-Iqbal, Karachi 75300, Sindh',
    province: 'SD',
  },
  sellerAddress: 'Shop 4, Zainab Market, Lahore, Punjab',
};

describe("What FBR's digital invoicing is sent of an invoice (TAX-04, ADR-562)", () => {
  it("names the seller and the buyer, and each item at its rate, in rupees, on the day in the shop's zone", () => {
    const body = diInvoiceBody(SOLD, SELLER, 'Asia/Karachi');
    const item = {
      uoM: 'Numbers, pieces, units',
      fixedNotifiedValueOrRetailPrice: 0,
      salesTaxWithheldAtSource: 0,
      extraTax: '',
      furtherTax: 0,
      sroScheduleNo: '',
      fedPayable: 0,
      saleType: 'Goods at standard rate (default)',
      sroItemSerialNo: '',
    };
    expect(body).toEqual({
      invoiceType: 'Sale Invoice',
      invoiceDate: '2026-10-17',
      sellerNTNCNIC: '1234567',
      sellerBusinessName: 'Zari',
      sellerProvince: 'Punjab',
      sellerAddress: 'Shop 4, Zainab Market, Lahore, Punjab',
      buyerNTNCNIC: '',
      buyerBusinessName: 'Ayesha Khan',
      buyerProvince: 'Sindh',
      buyerAddress: 'House 12, Street 4, Gulshan-e-Iqbal, Karachi 75300, Sindh',
      buyerRegistrationType: 'Unregistered',
      invoiceRefNo: '',
      items: [
        {
          ...item,
          productDescription: 'Lawn suit - Blue',
          rate: '18%',
          quantity: 2,
          totalValues: 1500,
          valueSalesExcludingST: 1271.19,
          salesTaxApplicable: 228.81,
          discount: 500,
        },
        {
          ...item,
          productDescription: 'Delivery',
          rate: '18%',
          quantity: 1,
          totalValues: 250,
          valueSalesExcludingST: 211.86,
          salesTaxApplicable: 38.14,
          discount: 0,
        },
      ],
    });

    // In production as it is; in the sandbox, against the scenario of an unregistered buyer.
    // Items go under the shop's PCT code, as an HS code; one with its own keeps it (ADR-557).
    const own = diInvoiceBody(
      { ...SOLD, items: [{ ...SOLD.items[0]!, pctCode: '62034200' }, SOLD.items[1]!] },
      SELLER,
      'Asia/Karachi',
    );
    expect(own.items[0]!.hsCode).toBe('6203.4200');
    const production = diInvoiceRequest(own, 'production', '62044200');
    expect(production.items.map((each) => each.hsCode)).toEqual(['6203.4200', '6204.4200']);
    expect(production).not.toHaveProperty('scenarioId');
    expect(diInvoiceRequest(own, 'sandbox', '62044200').scenarioId).toBe('SN002');
  });

  it('writes rates as FBR does, an item not taxed as exempt, and a CNIC as its digits', () => {
    const rated = (rate: number | null) =>
      diInvoiceBody(
        { ...SOLD, items: [{ ...SOLD.items[0]!, rate, tax: rate === null ? 0n : 1_00n }] },
        { ...SELLER, ntn: '35202-1234567-1' },
        'Asia/Karachi',
      );
    expect(rated(1750).items[0]).toMatchObject({ rate: '17.5%', saleType: expect.any(String) });
    expect(rated(1725).items[0]!.rate).toBe('17.25%');
    expect(rated(null).items[0]).toMatchObject({
      rate: 'Exempt',
      saleType: 'Exempt goods',
      salesTaxApplicable: 0,
      valueSalesExcludingST: 1500,
    });
    expect(rated(null).sellerNTNCNIC).toBe('3520212345671');
  });

  it("names provinces as FBR does, the seller's standing in for a buyer's not known", () => {
    expect(['PB', 'SD', 'KP', 'BA', 'IS', 'GB', 'JK', 'sd'].map(diProvinceOf)).toEqual([
      'Punjab',
      'Sindh',
      'Khyber Pakhtunkhwa',
      'Balochistan',
      'Islamabad Capital Territory',
      'Gilgit-Baltistan',
      'Azad Jammu and Kashmir',
      'Sindh',
    ]);
    expect(diProvinceOf('XX')).toBeNull();
    expect(diProvinceOf(null)).toBeNull();
    const unknown = diInvoiceBody(
      { ...SOLD, buyer: { ...SOLD.buyer!, province: 'XX' } },
      { ...SELLER, province: 'islamabad' },
      'Asia/Karachi',
    );
    expect(unknown).toMatchObject({
      sellerProvince: 'Islamabad Capital Territory',
      buyerProvince: 'Islamabad Capital Territory',
    });
    // Neither buyer nor address given: a customer, at the seller's province.
    expect(diInvoiceBody(INVOICE, SELLER, 'Asia/Karachi')).toMatchObject({
      sellerAddress: 'Punjab',
      buyerBusinessName: 'Customer',
      buyerProvince: 'Punjab',
      buyerAddress: 'Punjab',
    });
  });
});

describe("FBR's IMS and digital invoicing as the clients report to them", () => {
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

  it('gives the number digital invoicing gave once it found the invoice and each item valid, and says why not', async () => {
    const client = new FbrDigitalInvoicingClient({
      productionUrl: `${base}/di`,
      sandboxUrl: `${base}/di_sb`,
    });
    const body = diInvoiceBody(SOLD, SELLER, 'Asia/Karachi');
    const seller = (environment: 'sandbox' | 'production') => ({
      accessToken: TOKEN,
      environment,
      pctCode: '62044200',
    });
    const valid = { itemSNo: '1', statusCode: '00', status: 'Valid', errorCode: '', error: '' };
    answer = {
      status: 200,
      body: JSON.stringify({
        invoiceNumber: '7000007DI1747119701593',
        dated: '2025-05-13 12:01:41',
        validationResponse: {
          statusCode: '00',
          status: 'Valid',
          error: '',
          invoiceStatuses: [
            { ...valid, invoiceNo: '7000007DI1747119701593-1' },
            { ...valid, itemSNo: '2', invoiceNo: '7000007DI1747119701593-2' },
          ],
        },
      }),
    };
    expect(await client.report(seller('production'), body)).toEqual({
      ok: true,
      invoiceNumber: '7000007DI1747119701593',
    });
    const sent = seen.at(-1)!;
    expect(sent).toMatchObject({
      url: '/di',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { invoiceType: 'Sale Invoice', sellerNTNCNIC: '1234567', buyerProvince: 'Sindh' },
    });
    expect((sent.body as DiInvoiceBody).items.map((item) => item.hsCode)).toEqual([
      '6204.4200',
      '6204.4200',
    ]);
    expect(sent.body).not.toHaveProperty('scenarioId');
    await client.report(seller('sandbox'), body);
    expect(seen.at(-1)).toMatchObject({ url: '/di_sb', body: { scenarioId: 'SN002' } });

    // Invalid as a whole, or an item of it while the invoice is valid: refused, not tried again.
    answer = {
      status: 200,
      body: JSON.stringify({
        invoiceNumber: '',
        dated: '2025-05-13 12:01:41',
        validationResponse: {
          statusCode: '01',
          status: 'Invalid',
          errorCode: '0401',
          error: 'Unauthorized seller NTN',
          invoiceStatuses: null,
        },
      }),
    };
    expect(await client.report(seller('production'), body)).toEqual({
      ok: false,
      retry: false,
      message: 'FBR refused it (code 01): Unauthorized seller NTN (0401)',
    });
    answer = {
      status: 200,
      body: JSON.stringify({
        invoiceNumber: '7000007DI1747119701594',
        validationResponse: {
          statusCode: '00',
          status: 'Valid',
          error: '',
          invoiceStatuses: [
            valid,
            {
              itemSNo: '2',
              statusCode: '01',
              status: 'Invalid',
              errorCode: '0052',
              error: 'Provide proper HS Code',
            },
          ],
        },
      }),
    };
    expect(await client.report(seller('production'), body)).toEqual({
      ok: false,
      retry: false,
      message: 'FBR refused it (code 00): item 2: Provide proper HS Code (0052)',
    });

    // A token refused may be put right; FBR down, or answering nonsense, is tried again.
    answer = { status: 401, body: '' };
    expect(await client.report(seller('production'), body)).toEqual({
      ok: false,
      retry: true,
      message: "FBR refused the seller's token (401)",
    });
    answer = { status: 500, body: 'oops' };
    expect(await client.report(seller('production'), body)).toEqual({
      ok: false,
      retry: true,
      message: 'FBR 500: oops',
    });
    answer = { status: 200, body: '<html>busy</html>' };
    expect(await client.report(seller('production'), body)).toEqual({
      ok: false,
      retry: true,
      message: 'FBR answered what is not JSON: <html>busy</html>',
    });
    answer = { status: 400, body: 'Bad request' };
    expect(await client.report(seller('production'), body)).toEqual({
      ok: false,
      retry: false,
      message: 'FBR 400: Bad request',
    });
    const gone = new FbrDigitalInvoicingClient({
      productionUrl: 'http://127.0.0.1:1/',
      sandboxUrl: base,
    });
    expect(await gone.report(seller('production'), body)).toMatchObject({
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
    await admin.query('DELETE FROM tax.settings');
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
      system: 'pos',
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
      ['system', 'posId', 'accessToken', 'environment', 'pctCode'],
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
    expect(await pos.delete(a)).toEqual({ system: 'pos', posId: 123456 });
    expect(await pos.delete(a)).toBeNull();
    expect((await fiscal.list(a, { status: 'skipped' })).map((each) => each.usin)).toEqual([
      'INV/2026-27/00002',
    ]);
    expect(await fiscal.retry(a, failed.id)).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining('Connect') }],
    });
  });

  /** Shop A's tax settings: registered for sales tax, in Punjab, unless given. */
  const registered = (settings: { ntn?: string | null; strn?: string | null } = {}) =>
    admin.query(
      `INSERT INTO tax.settings (shop_id, ntn, strn, province) VALUES ($1, $2, $3, 'punjab')
           ON CONFLICT (shop_id) DO UPDATE SET ntn = excluded.ntn, strn = excluded.strn`,
      [
        a.shopId,
        settings.ntn === undefined ? '1234567-8' : settings.ntn,
        settings.strn === undefined ? '3277876175852' : settings.strn,
      ],
    );

  const DIGITAL = {
    system: 'digital_invoicing',
    accessToken: TOKEN,
    environment: 'sandbox',
    pctCode: '6204.4200',
  } as const;

  it('connects digital invoicing for a seller registered for sales tax, without a POS ID (ADR-562)', async () => {
    // Its tax settings name a seller registered for sales tax first.
    expect(await pos.update(a, DIGITAL)).toMatchObject({
      ok: false,
      errors: [
        {
          field: ['input', 'system'],
          code: 'INVALID',
          message:
            "FBR's digital invoicing is for sellers registered for sales tax: set the shop's NTN, " +
            'STRN and province in its tax settings first',
        },
      ],
    });
    await registered({ strn: null });
    expect(await pos.update(a, DIGITAL)).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining("set the shop's STRN in its tax settings") }],
    });
    await registered();
    expect(await pos.update(a, { ...DIGITAL, posId: 123456 })).toMatchObject({
      ok: false,
      errors: [{ field: ['input', 'posId'], code: 'INVALID' }],
    });
    expect(await pos.update(a, { ...DIGITAL, accessToken: undefined })).toMatchObject({
      ok: false,
      errors: [
        {
          field: ['input', 'accessToken'],
          code: 'BLANK',
          message: 'Connecting FBR needs the security token FBR issued the seller through IRIS',
        },
      ],
    });
    expect(unwrap(await pos.update(a, DIGITAL))).toMatchObject({
      system: 'digital_invoicing',
      posId: null,
      tokenHint: 'f818',
      environment: 'sandbox',
      pctCode: '62044200',
    });
    expect(await pos.connectionOf(a.shopId)).toEqual({
      system: 'digital_invoicing',
      accessToken: TOKEN,
      environment: 'sandbox',
      pctCode: '62044200',
    });

    // Its invoices are kept as digital invoicing takes them, from the seller and to the buyer;
    // its credit notes are not sent at all.
    const note: FiscalDocument = {
      ...INVOICE,
      kind: 'credit_note',
      usin: 'CN/2026-27/00001',
      refUsin: INVOICE.usin,
    };
    expect(await record(a.shopId, [SOLD, note])).toBe(2);
    const listed = await fiscal.list(a);
    expect(listed.map((each) => [each.usin, each.system, each.status, each.error])).toEqual([
      ['CN/2026-27/00001', 'digital_invoicing', 'skipped', DI_NO_CREDIT_NOTES],
      ['INV/2026-27/00001', 'digital_invoicing', 'pending', null],
    ]);
    const [claimed] = await fiscal.claim(a.shopId, new Date(Date.now() + 1_000), 10, 60_000);
    expect(claimed).toMatchObject({
      system: 'digital_invoicing',
      usin: 'INV/2026-27/00001',
      body: {
        sellerNTNCNIC: '1234567',
        sellerBusinessName: 'A',
        sellerProvince: 'Punjab',
        sellerAddress: 'Shop 4, Zainab Market, Lahore, Punjab',
        buyerBusinessName: 'Ayesha Khan',
        buyerProvince: 'Sindh',
      },
    });
    expect(claimed!.body).not.toHaveProperty('scenarioId');
    expect(await fiscal.retry(a, listed[0]!.id)).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining('takes no credit notes') }],
    });

    // One issued once its tax settings no longer name the seller waits for them, then goes.
    await registered({ ntn: null });
    expect(await record(a.shopId, [{ ...SOLD, usin: 'INV/2026-27/00002' }])).toBe(1);
    const [unnamed] = await fiscal.list(a, { status: 'failed' });
    expect(unnamed).toMatchObject({
      usin: 'INV/2026-27/00002',
      error: expect.stringContaining("set the shop's NTN in its tax settings"),
    });
    expect(await fiscal.retry(a, unnamed!.id)).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining("Set the shop's NTN") }],
    });
    await registered();
    expect(unwrap(await fiscal.retry(a, unnamed!.id))).toMatchObject({ status: 'pending' });
    const { rows } = await admin.query<{ payload: DiInvoiceBody }>(
      'SELECT payload FROM tax.fiscal_invoices WHERE shop_id = $1 AND id = $2',
      [a.shopId, unnamed!.id],
    );
    expect(rows[0]!.payload).toMatchObject({ sellerNTNCNIC: '1234567', buyerProvince: 'Sindh' });

    expect(await pos.delete(a)).toEqual({ system: 'digital_invoicing', posId: null });
  });

  it('switching how the shop reports needs the other token, and leaves those waiting for the other unsent', async () => {
    await registered();
    unwrap(
      await pos.update(a, {
        posId: 123456,
        accessToken: TOKEN,
        environment: 'production',
        pctCode: '62044200',
      }),
    );
    expect(await record(a.shopId, [INVOICE])).toBe(1);
    expect(await pos.update(a, { system: 'digital_invoicing' })).toMatchObject({
      ok: false,
      errors: [
        {
          field: ['input', 'accessToken'],
          code: 'BLANK',
          message:
            "Reporting through FBR's digital invoicing needs the security token FBR issued the " +
            'seller through IRIS',
        },
      ],
    });
    const DI_TOKEN = 'a7c3e9f1-0d5b-4c2e-9b8a-6f4d2e1c0b9a';
    expect(
      unwrap(await pos.update(a, { system: 'digital_invoicing', accessToken: DI_TOKEN })),
    ).toMatchObject({ system: 'digital_invoicing', posId: null, environment: 'production' });
    const [waited] = await fiscal.list(a);
    expect(waited).toMatchObject({
      system: 'pos',
      status: 'skipped',
      error: "Not reported: the shop now reports through FBR's digital invoicing",
    });
    expect(await fiscal.retry(a, waited!.id)).toMatchObject({
      ok: false,
      errors: [
        {
          message:
            "It was kept for FBR's POS integration, and the shop now reports through FBR's " +
            'digital invoicing',
        },
      ],
    });
    const { rows: audit } = await admin.query<{
      details: { changed: string[]; system: string };
    }>(
      `SELECT details FROM platform.audit_log WHERE shop_id = $1 AND action = 'fbr_pos.updated'
        ORDER BY id`,
      [a.shopId],
    );
    expect(audit.at(-1)!.details).toMatchObject({
      changed: ['system', 'posId', 'accessToken'],
      system: 'digital_invoicing',
    });
    const { rows: events } = await admin.query<{ payload: { system: string } }>(
      `SELECT payload FROM platform.outbox_events
        WHERE shop_id = $1 AND event_type = 'fbr_pos.updated'
        ORDER BY occurred_at, id`,
      [a.shopId],
    );
    expect(events.slice(-2).map((event) => event.payload.system)).toEqual([
      'pos',
      'digital_invoicing',
    ]);

    // Back to the POS needs its POS ID.
    expect(await pos.update(a, { system: 'pos', accessToken: TOKEN })).toMatchObject({
      ok: false,
      errors: [{ field: ['input', 'posId'], code: 'BLANK' }],
    });
  });
});
