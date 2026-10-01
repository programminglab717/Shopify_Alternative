import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProductImportService } from './product-import.service.js';
import { htmlToText, readShopifyProducts } from './shopify-csv.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

/** The headings of Shopify's product export, in its order. */
const HEADINGS = [
  'Handle',
  'Title',
  'Body (HTML)',
  'Vendor',
  'Product Category',
  'Type',
  'Tags',
  'Published',
  'Option1 Name',
  'Option1 Value',
  'Option2 Name',
  'Option2 Value',
  'Option3 Name',
  'Option3 Value',
  'Variant SKU',
  'Variant Grams',
  'Variant Inventory Tracker',
  'Variant Inventory Qty',
  'Variant Inventory Policy',
  'Variant Fulfillment Service',
  'Variant Price',
  'Variant Compare At Price',
  'Variant Requires Shipping',
  'Variant Taxable',
  'Variant Barcode',
  'Image Src',
  'Image Position',
  'Image Alt Text',
  'Gift Card',
  'SEO Title',
  'SEO Description',
  'Variant Image',
  'Variant Weight Unit',
  'Variant Tax Code',
  'Cost per item',
  'Status',
];

/** A file as Shopify writes one: CRLF, cells quoted where they must be, blanks left blank. */
function csvOf(rows: Readonly<Record<string, string | undefined>>[]): string {
  const cell = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [HEADINGS, ...rows.map((row) => HEADINGS.map((heading) => row[heading] ?? ''))]
    .map((cells) => cells.map(cell).join(','))
    .join('\r\n');
}

const CDN = 'https://cdn.shopify.com/s/files/1/0/files';

/** A lawn suit in two sizes and colours, its images over several rows. */
const LAWN = [
  {
    Handle: 'lawn-3-piece',
    Title: 'Lawn 3-Piece Suit',
    'Body (HTML)':
      '<p>Printed lawn, <strong>unstitched</strong>.</p>' +
      '<ul><li>Shirt 3 m</li><li>Dupatta &amp; trouser</li></ul>',
    Vendor: 'Zari',
    Type: 'Suits',
    Tags: 'Lawn, Eid, ',
    Published: 'TRUE',
    'Option1 Name': 'Size',
    'Option1 Value': 'S',
    'Option2 Name': 'Colour',
    'Option2 Value': 'Green',
    'Variant SKU': 'LAWN-S-G',
    'Variant Grams': '500.0',
    'Variant Inventory Tracker': 'shopify',
    'Variant Inventory Qty': '12',
    'Variant Inventory Policy': 'deny',
    'Variant Price': '4500.00',
    'Variant Compare At Price': '5500.00',
    'Variant Taxable': 'TRUE',
    'Image Src': `${CDN}/lawn-1.jpg`,
    'Image Position': '1',
    'Image Alt Text': 'Front',
    'Gift Card': 'FALSE',
    'Cost per item': '2000.00',
    Status: 'active',
  },
  {
    Handle: 'lawn-3-piece',
    'Option1 Value': 'M',
    'Option2 Value': 'Green',
    'Variant SKU': 'LAWN-M-G',
    'Variant Grams': '500',
    'Variant Inventory Tracker': 'shopify',
    'Variant Inventory Qty': '-3',
    'Variant Inventory Policy': 'continue',
    'Variant Price': '4500.00',
    'Image Src': `${CDN}/lawn-2.jpg`,
    'Image Position': '2',
    'Image Alt Text': 'Back',
    'Variant Image': `${CDN}/lawn-m.jpg`,
  },
  {
    Handle: 'lawn-3-piece',
    'Option1 Value': 'S',
    'Option2 Value': 'Blue',
    'Variant SKU': 'LAWN-S-B',
    'Variant Grams': '500',
    'Variant Price': '4700',
  },
  { Handle: 'lawn-3-piece', 'Image Src': 'http://example.com/lawn-3.jpg', 'Image Position': '3' },
];

/** A mug without options, as Shopify writes one: Title, Default Title. */
const MUG = [
  {
    Handle: 'chai-mug',
    Title: 'Chai Mug',
    'Body (HTML)': 'Holds 350&nbsp;ml.<br>Dishwasher safe.',
    Type: 'Mugs',
    Published: 'FALSE',
    'Option1 Name': 'Title',
    'Option1 Value': 'Default Title',
    'Variant SKU': 'MUG-1',
    'Variant Grams': '350',
    'Variant Inventory Tracker': 'shopify',
    'Variant Inventory Qty': '40',
    'Variant Price': '1,200.00',
    'Variant Taxable': 'FALSE',
    'Variant Barcode': '1234567890123',
  },
];

/** A book at a reduced rate, by Shopify's tax code. */
const BOOK = {
  Handle: 'quran',
  Title: 'Quran',
  'Option1 Name': 'Title',
  'Option1 Value': 'Default Title',
  'Variant Price': '1000',
  'Variant Tax Code': 'REDUCED',
  Status: 'active',
};

const GIFT_CARD = {
  Handle: 'gift',
  Title: 'Gift Card',
  'Option1 Name': 'Title',
  'Option1 Value': 'Default Title',
  'Variant Price': '1000',
  'Gift Card': 'TRUE',
  Status: 'active',
};

const UNTITLED = {
  Handle: 'no-title',
  'Option1 Name': 'Title',
  'Option1 Value': 'Default Title',
  'Variant Price': '100',
};

const FILE = csvOf([...LAWN, ...MUG, GIFT_CARD, UNTITLED]);

describe("Shopify's product CSV", () => {
  it('reads products from the rows that share a handle, and says what it leaves out', () => {
    const file = readShopifyProducts(FILE);
    if (!file.ok) throw new Error(file.message);
    expect(file.rows).toBe(7);
    const [lawn, mug] = file.products;
    expect(file.products).toHaveLength(2);
    expect(lawn).toEqual({
      handle: 'lawn-3-piece',
      row: 2,
      input: {
        title: 'Lawn 3-Piece Suit',
        handle: 'lawn-3-piece',
        description: 'Printed lawn, unstitched.\n\n- Shirt 3 m\n- Dupatta & trouser',
        vendor: 'Zari',
        productType: 'Suits',
        tags: ['Lawn', 'Eid'],
        status: 'active',
        options: [
          { name: 'Size', values: ['S', 'M'] },
          { name: 'Colour', values: ['Green', 'Blue'] },
        ],
        variants: [
          {
            optionValues: ['S', 'Green'],
            price: '4500.00',
            compareAtPrice: '5500.00',
            cost: '2000.00',
            sku: 'LAWN-S-G',
            weightGrams: 500,
          },
          { optionValues: ['M', 'Green'], price: '4500.00', sku: 'LAWN-M-G', weightGrams: 500 },
          { optionValues: ['S', 'Blue'], price: '4700', sku: 'LAWN-S-B', weightGrams: 500 },
        ],
      },
      variantRows: [2, 3, 4],
      // By position, then the variants' own; the http one left out.
      images: [
        { src: `${CDN}/lawn-1.jpg`, alt: 'Front', row: 2 },
        { src: `${CDN}/lawn-2.jpg`, alt: 'Back', row: 3 },
        { src: `${CDN}/lawn-m.jpg`, alt: '', row: 3 },
      ],
      // Tracked stock, never below nothing; untracked, none.
      stock: [
        { quantity: 12, continueSelling: false },
        { quantity: 0, continueSelling: true },
        null,
      ],
      // A variant's own image, one of the product's.
      variantImages: [null, `${CDN}/lawn-m.jpg`, null],
    });
    expect(mug).toMatchObject({
      handle: 'chai-mug',
      row: 6,
      input: {
        title: 'Chai Mug',
        description: 'Holds 350 ml.\nDishwasher safe.',
        productType: 'Mugs',
        tags: [],
        // Published FALSE, and no status: a draft. Its price includes no sales tax.
        status: 'draft',
        options: [],
        variants: [
          {
            price: '1,200.00',
            sku: 'MUG-1',
            barcode: '1234567890123',
            taxable: false,
            weightGrams: 350,
          },
        ],
      },
      images: [],
      stock: [{ quantity: 40, continueSelling: false }],
    });
    // A book's tax at the shop's category of its code.
    const books = readShopifyProducts(csvOf([BOOK]));
    if (!books.ok) throw new Error(books.message);
    expect(books.products[0]!.input.variants).toEqual([{ price: '1000', taxCode: 'REDUCED' }]);
    expect(file.problems).toEqual([
      {
        row: 5,
        column: 'Image Src',
        message: 'http://example.com/lawn-3.jpg is not an https address; the image is left out',
      },
      {
        row: 7,
        column: 'Gift Card',
        message: 'Gift cards are not imported: Hatti does not sell them yet',
      },
      {
        row: 8,
        column: 'Title',
        message: "Title is blank: a product's first row gives its title",
      },
    ]);
  });

  it('refuses a file it cannot read, or one that is not a product export', () => {
    expect(readShopifyProducts('  ')).toMatchObject({ ok: false, code: 'BLANK' });
    expect(readShopifyProducts('Handle,Title\n')).toMatchObject({ ok: false, code: 'BLANK' });
    expect(readShopifyProducts('Phone,Name\n+923001234567,Ayesha')).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
    expect(readShopifyProducts('Handle,Title\n"lawn,Lawn')).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
    const tooMany = csvOf(Array.from({ length: 5_001 }, () => MUG[0]!));
    expect(readShopifyProducts(tooMany)).toMatchObject({ ok: false, code: 'TOO_MANY' });
    // Headings as a spreadsheet may have left them.
    const loose = 'handle ,  TITLE,variant price\nmug,Mug,100';
    expect(readShopifyProducts(loose)).toMatchObject({ ok: true, products: [{ handle: 'mug' }] });
  });

  it("turns Shopify's HTML into the text descriptions are", () => {
    expect(htmlToText('<h2>Care</h2><p>Hand wash<br/>in cold water.</p>')).toBe(
      'Care\n\nHand wash\nin cold water.',
    );
    expect(htmlToText('<script>alert(1)</script><style>p{}</style>Plain &lt;b&gt; &#8377;99')).toBe(
      'Plain <b> ' + String.fromCharCode(0x20b9) + '99',
    );
    expect(htmlToText('Rang &rsquo;o&rsquo; roop&#x1F338; &#0; &#7;&unknown;')).toBe(
      'Rang ' +
        String.fromCharCode(0x2019) +
        'o' +
        String.fromCharCode(0x2019) +
        ' roop' +
        String.fromCodePoint(0x1f338) +
        ' &unknown;',
    );
  });
});

describe.skipIf(!server)('ProductImportService', () => {
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

  it('makes the products the file describes, keeping their handles, and says what it could not', async () => {
    const result = unwrap(await imports.import(f.a, FILE));
    expect(result).toMatchObject({
      rows: 7,
      created: 2,
      variants: 4,
      images: 3,
      skipped: 0,
      rowErrorCount: 3,
      dryRun: false,
    });
    expect(result.rowErrors.map((error) => [error.row, error.column])).toEqual([
      [5, 'Image Src'],
      [7, 'Gift Card'],
      [8, 'Title'],
    ]);
    const list = await f.products.list(f.a, { first: 10 });
    const lawn = list.items.find((product) => product.handle === 'lawn-3-piece')!;
    expect(lawn).toMatchObject({
      title: 'Lawn 3-Piece Suit',
      status: 'active',
      vendor: 'Zari',
      productType: 'Suits',
      tags: ['Lawn', 'Eid'],
      options: [
        { name: 'Size', values: [{ name: 'S' }, { name: 'M' }] },
        { name: 'Colour', values: [{ name: 'Green' }, { name: 'Blue' }] },
      ],
    });
    expect(
      lawn.variants.map((variant) => [
        variant.title,
        variant.sku,
        variant.price,
        variant.compareAtPrice,
        variant.cost,
        variant.weightGrams,
      ]),
    ).toEqual([
      ['S / Green', 'LAWN-S-G', 4_500_00n, 5_500_00n, 2_000_00n, 500],
      ['M / Green', 'LAWN-M-G', 4_500_00n, null, null, 500],
      ['S / Blue', 'LAWN-S-B', 4_700_00n, null, null, 500],
    ]);
    expect(lawn.media.map((media) => [media.sourceUrl, media.alt])).toEqual([
      [`${CDN}/lawn-1.jpg`, 'Front'],
      [`${CDN}/lawn-2.jpg`, 'Back'],
      [`${CDN}/lawn-m.jpg`, ''],
    ]);
    // Each variant shown with its own image, as Shopify showed it.
    expect(lawn.variants.map((variant) => variant.mediaId)).toEqual([
      null,
      lawn.media[2]!.id,
      null,
    ]);
    const mug = list.items.find((product) => product.handle === 'chai-mug')!;
    expect(mug).toMatchObject({ status: 'draft', variants: [{ price: 1_200_00n }] });
    // Stock for the inventory module to set, where Shopify tracked it.
    expect(result.stock).toEqual([
      { variantId: lawn.variants[0]!.id, row: 2, quantity: 12, continueSelling: false },
      { variantId: lawn.variants[1]!.id, row: 3, quantity: 0, continueSelling: true },
      { variantId: mug.variants[0]!.id, row: 6, quantity: 40, continueSelling: false },
    ]);

    // The same file again changes nothing: the shop has those handles.
    expect(unwrap(await imports.import(f.a, FILE))).toMatchObject({ created: 0, skipped: 2 });
    expect((await f.products.list(f.a, { first: 10 })).items).toHaveLength(2);
  });

  it('counts what a dry run would do, and does nothing', async () => {
    const result = unwrap(await imports.import(f.b, FILE, { dryRun: true }));
    expect(result).toMatchObject({ created: 2, variants: 4, images: 3, dryRun: true, stock: [] });
    expect((await f.products.list(f.b, { first: 10 })).items).toEqual([]);
    expect(await f.outbox()).toEqual([]);
  });

  it("says what the catalog would not take at the variant's row and column, and takes the rest", async () => {
    const file = csvOf([
      ...MUG,
      { ...LAWN[0]!, 'Variant Price': 'free' },
      ...LAWN.slice(1),
      { Handle: 'plain', Title: 'x'.repeat(300), 'Variant Price': '10' },
    ]);
    const result = unwrap(await imports.import(f.a, file));
    expect(result).toMatchObject({ created: 1, rowErrorCount: 3 });
    expect(result.rowErrors.map((error) => [error.row, error.column])).toEqual([
      [3, 'Variant Price'],
      [6, 'Image Src'],
      [7, 'Title'],
    ]);
    expect(errorsOf(await imports.import(f.a, ''))).toEqual([['csv', 'BLANK']]);
  });
});
