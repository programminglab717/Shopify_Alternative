import 'reflect-metadata';
import { parseCsv, toCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProductRecord } from './records.js';
import { SHOPIFY_INVENTORY_HEADINGS, readShopifyInventory } from './shopify-inventory-csv.js';
import type { StockLevel } from './shopify-inventory-csv.js';
import { StockFileService } from './stock-file.service.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

/** A file's rows as their headings and cells, blank cells left out. */
function recordsOf(csv: string): Record<string, string>[] {
  const [headings, ...rows] = parseCsv(csv);
  expect(headings).toEqual([...SHOPIFY_INVENTORY_HEADINGS]);
  return rows.map((cells) =>
    Object.fromEntries(
      SHOPIFY_INVENTORY_HEADINGS.flatMap((heading, at) =>
        cells[at] ? [[heading, cells[at]]] : [],
      ),
    ),
  );
}

/** A file of these rows under Shopify's headings, cells by heading. */
function fileOf(rows: Partial<Record<(typeof SHOPIFY_INVENTORY_HEADINGS)[number], string>>[]) {
  return toCsv([
    [...SHOPIFY_INVENTORY_HEADINGS],
    ...rows.map((row) => SHOPIFY_INVENTORY_HEADINGS.map((heading) => row[heading] ?? '')),
  ]);
}

describe("Shopify's inventory CSV", () => {
  it('reads the rows that count stock, and says what is wrong with the others', () => {
    const file = readShopifyInventory(
      fileOf([
        { Handle: 'kurta', 'Option1 Value': 'M', Location: 'Shop', 'On hand (new)': '1,200' },
        { Handle: 'kurta', 'Option1 Value': 'L', Location: 'Shop' },
        { Handle: '', Location: 'Shop', 'On hand (new)': '3' },
        { Handle: 'kurta', Location: '', 'On hand (new)': '3' },
        { Handle: 'kurta', Location: 'Shop', 'On hand (new)': '-1' },
        {
          Handle: 'kurta',
          Location: 'Shop',
          'On hand (current)': 'some',
          'On hand (new)': '2',
        },
        { Handle: 'Mug', Location: 'Shop', 'On hand (current)': '-2', 'On hand (new)': '0' },
      ]),
    );
    expect(file).toMatchObject({
      ok: true,
      rows: 7,
      unchanged: 1,
      counts: [
        { row: 2, handle: 'kurta', optionValues: ['M', '', ''], quantity: 1_200, current: null },
        { row: 8, handle: 'mug', location: 'Shop', current: -2, quantity: 0 },
      ],
    });
    expect(file.ok && file.problems.map((problem) => [problem.row, problem.column])).toEqual([
      [4, 'Handle'],
      [5, 'Location'],
      [6, 'On hand (new)'],
      [7, 'On hand (current)'],
    ]);
    expect(readShopifyInventory('Handle,Title\nkurta,Kurta')).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
    expect(readShopifyInventory('')).toMatchObject({ ok: false, code: 'BLANK' });
  });
});

describe.skipIf(!server)('StockFileService', () => {
  let f: CatalogFixture;
  let files: StockFileService;

  beforeAll(async () => {
    f = await catalogFixture(server!);
    files = new StockFileService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  /** A suit in two sizes, and a mug without options. */
  async function catalog(): Promise<{ suit: ProductRecord; mug: ProductRecord }> {
    const suit = unwrap(
      await f.products.create(f.a, {
        title: 'Lawn Suit',
        status: 'active',
        options: [{ name: 'Size', values: ['S', 'M'] }],
        variants: [
          { optionValues: ['S'], price: '4,500', sku: 'LAWN-S' },
          { optionValues: ['M'], price: '4,500' },
        ],
      }),
    );
    const mug = unwrap(
      await f.products.create(f.a, {
        title: 'Chai Mug',
        status: 'draft',
        variants: [{ price: '900' }],
      }),
    );
    return { suit, mug };
  }

  const level = (location: string, onHand: number, committed = 0): StockLevel => ({
    location,
    onHand,
    committed,
    available: onHand - committed,
    unavailable: 0,
  });

  it("writes each variant's stock at each location, a row each, and reads it back", async () => {
    const { suit, mug } = await catalog();
    const [small, medium] = suit.variants;
    const { csv, products, rows } = unwrap(
      await files.export(f.a, '', async (variantIds) => {
        expect(variantIds).toEqual([small!.id, medium!.id, mug.variants[0]!.id]);
        // The medium is not tracked: no rows.
        return new Map([
          [small!.id, [level('Shop', 5, 2), level('Warehouse', 20)]],
          [mug.variants[0]!.id, [level('Shop', 3)]],
        ]);
      }),
    );
    expect({ products, rows }).toEqual({ products: 2, rows: 3 });
    expect(recordsOf(csv)).toEqual([
      {
        Handle: 'lawn-suit',
        Title: 'Lawn Suit',
        'Option1 Name': 'Size',
        'Option1 Value': 'S',
        SKU: 'LAWN-S',
        Location: 'Shop',
        'Incoming (not editable)': '0',
        'Unavailable (not editable)': '0',
        'Committed (not editable)': '2',
        'Available (not editable)': '3',
        'On hand (current)': '5',
      },
      expect.objectContaining({ Location: 'Warehouse', 'On hand (current)': '20' }),
      {
        Handle: 'chai-mug',
        Title: 'Chai Mug',
        'Option1 Name': 'Title',
        'Option1 Value': 'Default Title',
        Location: 'Shop',
        'Incoming (not editable)': '0',
        'Unavailable (not editable)': '0',
        'Committed (not editable)': '0',
        'Available (not editable)': '3',
        'On hand (current)': '3',
      },
    ]);
    // Filtered as the products list is; the other shop's file is empty.
    expect(unwrap(await files.export(f.a, 'status:draft', async () => new Map()))).toMatchObject({
      products: 1,
      rows: 0,
    });
    expect(unwrap(await files.export(f.b, '', async () => new Map()))).toMatchObject({
      products: 0,
    });

    // Counted: the warehouse's small suits, and a mug; the file is read back to variants.
    const [header, ...cells] = parseCsv(csv);
    const fresh = header!.indexOf('On hand (new)');
    cells[1]![fresh] = '18';
    cells[2]![fresh] = '4';
    const read = unwrap(await files.read(f.a, toCsv([header!, ...cells])));
    expect(read).toEqual({
      rows: 3,
      unchanged: 1,
      problems: [],
      counts: [
        {
          row: 3,
          variantId: small!.id,
          name: 'Lawn Suit (S)',
          location: 'Warehouse',
          current: 20,
          quantity: 18,
        },
        {
          row: 4,
          variantId: mug.variants[0]!.id,
          name: 'Chai Mug',
          location: 'Shop',
          current: 3,
          quantity: 4,
        },
      ],
    });
  });

  it('finds variants by their option values in any case, and says which it cannot', async () => {
    const { suit } = await catalog();
    const read = unwrap(
      await files.read(
        f.a,
        fileOf([
          { Handle: 'Lawn-Suit', 'Option1 Value': 'm', Location: 'shop', 'On hand (new)': '7' },
          { Handle: 'lawn-suit', 'Option1 Value': 'XL', Location: 'Shop', 'On hand (new)': '1' },
          { Handle: 'shawl', Location: 'Shop', 'On hand (new)': '1' },
        ]),
      ),
    );
    expect(read.counts).toEqual([
      expect.objectContaining({ row: 2, variantId: suit.variants[1]!.id, location: 'shop' }),
    ]);
    expect(read.problems).toEqual([
      { row: 3, column: 'Option1 Value', message: '"Lawn Suit" has no variant "XL"' },
      { row: 4, column: 'Handle', message: 'No product has the handle "shawl"' },
    ]);
    // Another shop's products are not this one's.
    expect(
      unwrap(
        await files.read(
          f.b,
          fileOf([
            { Handle: 'lawn-suit', 'Option1 Value': 'M', Location: 'Shop', 'On hand (new)': '1' },
          ]),
        ),
      ).problems,
    ).toHaveLength(1);
    expect(errorsOf(await files.read(f.a, 'Handle\nlawn-suit'))).toEqual([['csv', 'INVALID']]);
  });

  it('refuses a file larger than an import takes, saying what to narrow', async () => {
    const { suit } = await catalog();
    const many = await files.export(f.a, '', async () => new Map(), { rows: 2 });
    expect(errorsOf(many)).toEqual([['query', 'TOO_MANY']]);
    // Few variants, but at many locations.
    const wide = await files.export(
      f.a,
      'status:active',
      async () => new Map([[suit.variants[0]!.id, [level('A', 1), level('B', 1), level('C', 1)]]]),
      { rows: 2 },
    );
    expect(!wide.ok && wide.errors[0]!.message).toContain('or by location');
  });
});
