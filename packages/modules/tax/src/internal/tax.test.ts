import 'reflect-metadata';
import { InputChecker, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { taxSettings } from './schema.js';
import { TaxSettingsService } from './tax-settings.service.js';
import {
  NO_TAX,
  checkTaxRate,
  includedTax,
  orderTaxOf,
  ratePercent,
  taxIncludedWords,
} from './tax.js';

const server = testDatabaseServer();

describe('includedTax', () => {
  it('is the part of an amount that is tax at a rate, rounded half up to the paisa', () => {
    // Rs 1,180 at 18% is Rs 1,000 and Rs 180 of tax.
    expect(includedTax(1_180_00n, 1_800)).toBe(180_00n);
    // Rs 2,500 at 18%: Rs 381.355… of tax.
    expect(includedTax(2_500_00n, 1_800)).toBe(381_36n);
    // At 20%, a sixth: 0.5 paisa rounds up, less rounds down.
    expect(includedTax(3n, 2_000)).toBe(1n);
    expect(includedTax(2n, 2_000)).toBe(0n);
    expect(includedTax(0n, 1_800)).toBe(0n);
    expect(includedTax(-100n, 1_800)).toBe(0n);
  });
});

describe('orderTaxOf', () => {
  const lines = [
    { total: 2_000_00n, taxable: true },
    { total: 1_000_00n, taxable: false },
  ];

  it('taxes each taxable line on what was paid for it, after its share of the discount', () => {
    // Rs 300 off, shared 2:1: the first line is paid Rs 1,800, which includes Rs 274.576….
    expect(
      orderTaxOf(
        { rate: 1_800, taxDelivery: false },
        { lines, discount: 300_00n, charges: 250_00n },
      ),
    ).toEqual({ rate: 1_800, lines: [274_58n, 0n], charges: 0n, total: 274_58n });
  });

  it('taxes delivery and the fee for paying on delivery where the shop says so', () => {
    // Rs 250 of charges include Rs 38.135….
    expect(
      orderTaxOf(
        { rate: 1_800, taxDelivery: true },
        { lines, discount: 300_00n, charges: 250_00n },
      ),
    ).toEqual({ rate: 1_800, lines: [274_58n, 0n], charges: 38_14n, total: 312_72n });
  });

  it('shares the discount by the largest remainder, the odd paisa to the first line', () => {
    // 75 paisa off two lines of Re 1: the first is paid 62 paisa and the second 63, which
    // include 10.33 and 10.5 paisa of tax at 20%.
    const two = [
      { total: 100n, taxable: true },
      { total: 100n, taxable: true },
    ];
    expect(
      orderTaxOf({ rate: 2_000, taxDelivery: false }, { lines: two, discount: 75n, charges: 0n })
        .lines,
    ).toEqual([10n, 11n]);
    // All of it off: nothing paid, no tax.
    expect(
      orderTaxOf({ rate: 1_800, taxDelivery: true }, { lines, discount: 3_000_00n, charges: 0n })
        .total,
    ).toBe(0n);
  });

  it('is nothing for a shop that charges none', () => {
    expect(orderTaxOf(NO_TAX, { lines, discount: 0n, charges: 250_00n })).toEqual({
      rate: null,
      lines: [0n, 0n],
      charges: 0n,
      total: 0n,
    });
  });
});

describe('rates', () => {
  it('reads as a percentage, and says what a total includes in English and Urdu', () => {
    expect(ratePercent(1_800)).toBe('18%');
    expect(ratePercent(1_750)).toBe('17.5%');
    expect(taxIncludedWords(1_800)).toEqual({
      en: 'Sales tax 18% (included)',
      ur: 'سیلز ٹیکس 18% (شامل)',
    });
  });

  it('are checked as percentages from 0.01 to 50, in hundredths', () => {
    const rate = (percentage: number) => {
      const check = new InputChecker();
      const checked = checkTaxRate(check, ['rate'], percentage);
      return check.ok ? checked : check.errors.map((error) => error.message);
    };
    expect(rate(18)).toBe(1_800);
    expect(rate(17.5)).toBe(1_750);
    expect(rate(0.01)).toBe(1);
    expect(rate(50)).toBe(5_000);
    const refused = [
      'Rate must be a percentage from 0.01 to 50, with two decimals at most, like 18 or 17.5',
    ];
    for (const wrong of [0, -18, 50.01, 18.555, Number.NaN]) expect(rate(wrong)).toEqual(refused);
  });
});

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_settings']),
  };
}

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

describe.skipIf(!server)('TaxSettingsService', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let service: TaxSettingsService;
  const a = tenant(newId());
  const b = tenant(newId());

  const outbox = async () =>
    (
      await admin.query<{ event_type: string; payload: unknown }>(
        'SELECT event_type, payload FROM platform.outbox_events ORDER BY id',
      )
    ).rows.map((row) => [row.event_type, row.payload]);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'tax-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    service = new TaxSettingsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM tax.settings; DELETE FROM platform.outbox_events; ' +
        'DELETE FROM platform.audit_log',
    );
  });

  it('matches the migrated table', async () => {
    await db.tenant(a.shopId, (tx) => tx.select().from(taxSettings).limit(1));
  });

  it('charges none until the shop sets a rate, which it changes for orders from then on', async () => {
    expect(await service.get(a)).toEqual(NO_TAX);
    const set = unwrap(await service.update(a, { rate: 18 }));
    expect(set).toMatchObject({ rate: 1_800, taxDelivery: false });
    expect(set.updatedAt).toBeInstanceOf(Date);
    // The same again changes nothing; then delivery too; then no tax at all.
    unwrap(await service.update(a, { rate: 18, taxDelivery: null }));
    expect(unwrap(await service.update(a, { taxDelivery: true }))).toMatchObject({
      rate: 1_800,
      taxDelivery: true,
    });
    expect(unwrap(await service.update(a, { rate: null }))).toMatchObject({
      rate: null,
      taxDelivery: true,
    });
    expect(await outbox()).toEqual([
      ['tax_settings.updated', { changed: ['rate'] }],
      ['tax_settings.updated', { changed: ['taxDelivery'] }],
      ['tax_settings.updated', { changed: ['rate'] }],
    ]);
    // Who changed it, and to what, as the API has it.
    const { rows } = await admin.query<{ action: string; details: unknown }>(
      'SELECT action, details FROM platform.audit_log ORDER BY id',
    );
    expect(rows).toEqual([
      { action: 'tax_settings.updated', details: { rate: 18, taxDelivery: false } },
      { action: 'tax_settings.updated', details: { rate: 18, taxDelivery: true } },
      { action: 'tax_settings.updated', details: { rate: null, taxDelivery: true } },
    ]);
    // Each shop its own.
    expect(await service.get(b)).toEqual(NO_TAX);
  });

  it('refuses a rate that is not one, changing nothing', async () => {
    const refused = await service.update(a, { rate: 0, taxDelivery: true });
    expect(refused).toEqual({
      ok: false,
      errors: [
        {
          field: ['input', 'rate'],
          code: 'INVALID',
          message:
            'Rate must be a percentage from 0.01 to 50, with two decimals at most, like 18 or ' +
            '17.5',
        },
      ],
    });
    expect(await service.get(a)).toEqual(NO_TAX);
    expect(await outbox()).toEqual([]);
  });
});
