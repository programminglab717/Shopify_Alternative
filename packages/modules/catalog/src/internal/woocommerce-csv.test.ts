import 'reflect-metadata';
import { toCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProductImportService } from './product-import.service.js';
import { catalogFixture, unwrap, type CatalogFixture } from './test-support.js';
import { readWooCommerceProducts } from './woocommerce-csv.js';

const server = testDatabaseServer();

/** WooCommerce's product export headings, those the import reads among the rest, in its order. */
const HEADINGS = [
  'ID',
  'Type',
  'SKU',
  'Name',
  'Published',
  'Is featured?',
  'Short description',
  'Description',
  'Tax status',
  'In stock?',
  'Stock',
  'Backorders allowed?',
  'Weight (kg)',
  'Sale price',
  'Regular price',
  'Categories',
  'Tags',
  'Images',
  'Parent',
  'Attribute 1 name',
  'Attribute 1 value(s)',
  'Attribute 1 visible',
  'Attribute 1 global',
  'Attribute 2 name',
  'Attribute 2 value(s)',
  'Attribute 2 visible',
  'Attribute 2 global',
];

/** A row of the export, by heading; the rest blank. */
function row(cells: Record<string, string>): string[] {
  return HEADINGS.map((heading) => cells[heading] ?? '');
}

const FILE =
  String.fromCharCode(0xfeff) +
  toCsv([
    HEADINGS,
    row({
      ID: '41',
      Type: 'variable',
      SKU: 'LAWN-3PC',
      Name: 'Lawn 3-Piece Suit',
      Published: '1',
      Description: '<p>Printed lawn, <strong>3 pieces</strong>.</p>',
      'Weight (kg)': '0.75',
      Categories: 'Women > Lawn, Eid Collection',
      Tags: 'summer, printed',
      Images: 'https://shop.example/lawn-1.jpg, https://shop.example/lawn-2.jpg',
      'Attribute 1 name': 'Size',
      'Attribute 1 value(s)': 'S, M',
      'Attribute 2 name': 'Fabric',
      'Attribute 2 value(s)': 'Lawn',
    }),
    row({
      ID: '42',
      Type: 'variation',
      SKU: 'LAWN-3PC-S',
      Name: 'Lawn 3-Piece Suit - S',
      Published: '1',
      Stock: '7',
      'Sale price': '3990',
      'Regular price': '4990',
      Parent: 'id:41',
      Images: 'https://shop.example/lawn-s.jpg',
      'Attribute 1 name': 'Size',
      'Attribute 1 value(s)': 'S',
    }),
    row({
      ID: '43',
      Type: 'variation',
      SKU: 'LAWN-3PC-M',
      Name: 'Lawn 3-Piece Suit - M',
      Published: '1',
      Stock: '0',
      'Backorders allowed?': 'notify',
      'Regular price': '4990',
      Parent: 'LAWN-3PC',
      'Attribute 1 name': 'Size',
      'Attribute 1 value(s)': 'M',
    }),
    row({
      ID: '50',
      Type: 'simple',
      SKU: 'KHUSSA-1',
      Name: 'Multan Khussa',
      Published: '0',
      'Short description': 'Hand-made.',
      'Tax status': 'none',
      'Regular price': '2500',
      'Weight (kg)': 'heavy',
      Images: 'http://shop.example/khussa.jpg',
    }),
    row({ ID: '60', Type: 'grouped', Name: 'Eid bundle' }),
    row({ ID: '61', Type: 'variation', Name: 'Lost', Parent: 'id:999', 'Regular price': '10' }),
    row({ ID: '70', Type: 'simple', Name: 'Multan Khussa', 'Regular price': '2600' }),
  ]);

describe("WooCommerce's product CSV (ADR-482)", () => {
  it('reads simple and variable products, their variations its variants', () => {
    const file = readWooCommerceProducts(FILE);
    if (!file.ok) throw new Error(file.message);
    expect(file.rows).toBe(7);
    const [lawn, khussa, second] = file.products;
    expect(lawn).toMatchObject({
      handle: 'lawn-3-piece-suit',
      row: 2,
      input: {
        title: 'Lawn 3-Piece Suit',
        description: 'Printed lawn, 3 pieces.',
        productType: 'Lawn',
        tags: ['summer', 'printed', 'Eid Collection'],
        status: 'active',
        // Fabric is the same for every variation: no option.
        options: [{ name: 'Size', values: ['S', 'M'] }],
        variants: [
          {
            optionValues: ['S'],
            price: '3990',
            compareAtPrice: '4990',
            sku: 'LAWN-3PC-S',
            weightGrams: 750,
          },
          { optionValues: ['M'], price: '4990', sku: 'LAWN-3PC-M', weightGrams: 750 },
        ],
      },
      variantRows: [3, 4],
      stock: [
        { quantity: 7, continueSelling: false },
        { quantity: 0, continueSelling: true },
      ],
      variantImages: ['https://shop.example/lawn-s.jpg', null],
    });
    expect(lawn!.images.map((image) => image.src)).toEqual([
      'https://shop.example/lawn-1.jpg',
      'https://shop.example/lawn-2.jpg',
      'https://shop.example/lawn-s.jpg',
    ]);
    expect(khussa).toMatchObject({
      handle: 'multan-khussa',
      input: {
        description: 'Hand-made.',
        status: 'draft',
        options: [],
        variants: [{ price: '2500', sku: 'KHUSSA-1', taxable: false }],
      },
      stock: [null],
      images: [],
    });
    // The same name twice: the second gets an address of its own.
    expect(second!.handle).toBe('multan-khussa-2');
    expect(file.problems.map((problem) => [problem.row, problem.column])).toEqual([
      [5, 'Weight (kg)'],
      [5, 'Images'],
      [6, 'Type'],
      [7, 'Parent'],
    ]);
    expect(file.columns.has('price')).toBe(true);
    expect(file.columns.has('variantImage')).toBe(false);
  });

  it('refuses a file that is not a WooCommerce product export', () => {
    expect(readWooCommerceProducts('')).toMatchObject({ ok: false, code: 'BLANK' });
    expect(readWooCommerceProducts('Handle,Title\nkurta,Kurta\n')).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
  });

  it('leaves out a variation for any value of an attribute, and a variable product without one', () => {
    const file = readWooCommerceProducts(
      toCsv([
        HEADINGS,
        row({ ID: '1', Type: 'variable', Name: 'Kurta', 'Attribute 1 name': 'Size' }),
        row({
          ID: '2',
          Type: 'variation',
          Parent: 'id:1',
          'Regular price': '10',
          'Attribute 1 name': 'Size',
        }),
        row({ ID: '3', Type: 'variable', Name: 'Shalwar' }),
      ]),
    );
    if (!file.ok) throw new Error(file.message);
    expect(file.products).toEqual([]);
    expect(file.problems.map((problem) => problem.row)).toEqual([3, 4]);
  });
});

describe.skipIf(!server)('Importing a WooCommerce export (ADR-482)', () => {
  let f: CatalogFixture;
  let imports: ProductImportService;

  beforeAll(async () => {
    f = await catalogFixture(server!);
    imports = new ProductImportService(f.db, f.products, f.media, f.variants);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it("makes the shop's products from it, with their stock to set", async () => {
    const result = unwrap(await imports.import(f.a, FILE, { format: 'woocommerce' }));
    expect(result).toMatchObject({ rows: 7, created: 3, variants: 4, images: 3, skipped: 0 });
    expect(result.stock.map((entry) => [entry.row, entry.quantity, entry.continueSelling])).toEqual(
      [
        [3, 7, false],
        [4, 0, true],
      ],
    );
    const { items } = await f.products.list(f.a, { first: 10 });
    const lawn = items.find((product) => product.handle === 'lawn-3-piece-suit')!;
    expect(
      lawn.variants.map((variant) => [variant.sku, variant.price, variant.compareAtPrice]),
    ).toEqual([
      ['LAWN-3PC-S', 399_000n, 499_000n],
      ['LAWN-3PC-M', 499_000n, null],
    ]);
    // Shopify's file is not WooCommerce's.
    expect(await imports.import(f.a, FILE)).toMatchObject({ ok: false });
  });
});
