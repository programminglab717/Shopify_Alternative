import 'reflect-metadata';
import { parseCsv, toCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProductExportService } from './product-export.service.js';
import { ProductImportService } from './product-import.service.js';
import type { ProductRecord } from './records.js';
import {
  SHOPIFY_PRODUCT_HEADINGS,
  htmlToText,
  readShopifyProducts,
  textToHtml,
  writeShopifyProducts,
} from './shopify-csv.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

const CDN = 'https://cdn.example.pk/files';

/** A file's rows as their headings and cells, blank cells left out. */
function recordsOf(csv: string): Record<string, string>[] {
  const [headings, ...rows] = parseCsv(csv);
  expect(headings).toEqual([...SHOPIFY_PRODUCT_HEADINGS]);
  return rows.map((cells) =>
    Object.fromEntries(
      SHOPIFY_PRODUCT_HEADINGS.flatMap((heading, at) => (cells[at] ? [[heading, cells[at]]] : [])),
    ),
  );
}

/** What a product is, whichever shop has it: no IDs. */
function shapeOf(product: ProductRecord) {
  const imageOf = new Map(product.media.map((media) => [media.id, media.sourceUrl]));
  return {
    handle: product.handle,
    title: product.title,
    description: product.description,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    status: product.status,
    seo: product.seo,
    options: product.options.map((option) => [option.name, option.values.map((v) => v.name)]),
    variants: product.variants.map((variant) => ({
      title: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      cost: variant.cost,
      weightGrams: variant.weightGrams,
      taxable: variant.taxable,
      taxCode: variant.taxCode,
      image: variant.mediaId ? imageOf.get(variant.mediaId) : null,
    })),
    media: product.media.map((media) => [media.sourceUrl, media.alt]),
  };
}

/** A product without options: a chai mug, its one variant 'v' at Rs 900. */
function mugRecord(): ProductRecord {
  return {
    id: 'p',
    title: 'Chai Mug',
    handle: 'chai-mug',
    status: 'active',
    description: '',
    vendor: null,
    productType: null,
    tags: [],
    seo: { title: null, description: null },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    options: [],
    media: [],
    variants: [
      {
        id: 'v',
        productId: 'p',
        title: 'Default Title',
        sku: null,
        barcode: null,
        price: 900_00n,
        compareAtPrice: null,
        cost: null,
        weightGrams: null,
        taxable: true,
        taxCode: null,
        position: 1,
        selectedOptions: [],
        mediaId: null,
      },
    ],
  };
}

describe("Products to Shopify's CSV", () => {
  it("writes a description as Shopify's HTML, which reads back the same", () => {
    const text = 'Printed lawn & chiffon.\nShirt: 3 m <unstitched>.\n\nDry clean only.';
    expect(textToHtml(text)).toBe(
      '<p>Printed lawn &amp; chiffon.<br>Shirt: 3 m &lt;unstitched&gt;.</p>' +
        '<p>Dry clean only.</p>',
    );
    expect(htmlToText(textToHtml(text))).toBe(text);
    expect(textToHtml('')).toBe('');
  });

  it('writes stock sold past zero as a number, which the import reads back', () => {
    const mug = mugRecord();
    const { csv } = writeShopifyProducts(
      [mug],
      'PKR',
      new Map([['v', { quantity: -2, continueSelling: true }]]),
    );
    expect(recordsOf(csv)[0]).toMatchObject({ 'Variant Inventory Qty': '-2' });
    const read = readShopifyProducts(csv);
    expect(read.ok && read.problems).toEqual([]);
    // Nothing below zero is set: the import takes stock from zero.
    expect(read.ok && read.products[0]!.stock).toEqual([{ quantity: 0, continueSelling: true }]);
    // A spreadsheet's apostrophe before it reads the same.
    const quoted = csv.replace(',-2,', ",'-2,");
    expect(quoted).not.toBe(csv);
    const again = readShopifyProducts(quoted);
    expect(again.ok && again.products[0]!.stock).toEqual([{ quantity: 0, continueSelling: true }]);
  });

  it("writes a product's title and description for search engines, which the import reads back", () => {
    const mug = {
      ...mugRecord(),
      seo: { title: 'Hand-painted chai mugs', description: 'Chai mugs painted by hand in Multan.' },
    };
    const { csv } = writeShopifyProducts([mug], 'PKR', null);
    expect(recordsOf(csv)[0]).toMatchObject({
      'SEO Title': 'Hand-painted chai mugs',
      'SEO Description': 'Chai mugs painted by hand in Multan.',
    });
    const read = readShopifyProducts(csv);
    expect(read.ok && read.products[0]!.input.seo).toEqual(mug.seo);
    // Neither, and none is given.
    const plain = readShopifyProducts(writeShopifyProducts([mugRecord()], 'PKR', null).csv);
    expect(plain.ok && 'seo' in plain.products[0]!.input).toBe(false);
  });
});

describe.skipIf(!server)('ProductExportService', () => {
  let f: CatalogFixture;
  let exports: ProductExportService;
  let imports: ProductImportService;

  beforeAll(async () => {
    f = await catalogFixture(server!);
    exports = new ProductExportService(f.db);
    imports = new ProductImportService(f.db, f.products, f.media, f.variants);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  /** A suit in two sizes, with three images, one a variant's own; a mug without options. */
  async function catalog(): Promise<{ suit: ProductRecord; mug: ProductRecord }> {
    const made = unwrap(
      await f.products.create(f.a, {
        title: 'Lawn 3-Piece Suit',
        description: 'Printed lawn.\n\nDry clean only.',
        vendor: 'Zari',
        productType: 'Suits',
        tags: ['Eid', 'Lawn'],
        status: 'active',
        seo: { title: 'Lawn suits for Eid', description: 'Printed lawn three-piece suits.' },
        options: [
          { name: 'Size', values: ['S', 'M'] },
          { name: 'Colour', values: ['Green'] },
        ],
        variants: [
          {
            optionValues: ['S', 'Green'],
            price: '4,500',
            compareAtPrice: '5,500',
            cost: '2,000',
            sku: 'LAWN-S-G',
            barcode: '8964000123456',
            weightGrams: 500,
            taxCode: 'REDUCED',
          },
          { optionValues: ['M', 'Green'], price: '4,500', taxable: false },
        ],
      }),
    );
    const { mediaIds } = unwrap(
      await f.media.create(f.a, made.id, [
        { originalSource: `${CDN}/lawn-1.jpg`, alt: 'Front' },
        { originalSource: `${CDN}/lawn-2.jpg`, alt: 'Back' },
        { originalSource: `${CDN}/lawn-3.jpg` },
      ]),
    );
    const suit = unwrap(
      await f.variants.bulkUpdate(f.a, made.id, [
        { id: made.variants[1]!.id, mediaId: mediaIds[1]! },
      ]),
    ).product;
    const mug = unwrap(
      await f.products.create(f.a, {
        title: 'Chai Mug',
        status: 'draft',
        variants: [{ price: '1,200' }],
      }),
    );
    return { suit, mug };
  }

  it("writes the shop's products as Shopify's CSV, a row for each variant and image", async () => {
    const { suit, mug } = await catalog();
    const asked: string[][] = [];
    const { csv, products, rows } = unwrap(
      await exports.export(f.a, '', async (variantIds) => {
        asked.push(variantIds);
        return new Map([
          [suit.variants[0]!.id, { quantity: 12, continueSelling: false }],
          [suit.variants[1]!.id, { quantity: 0, continueSelling: true }],
        ]);
      }),
    );
    expect([products, rows]).toEqual([2, 4]);
    // The caller gives the stock of the variants exported, in one call.
    expect(asked).toEqual([[...suit.variants, ...mug.variants].map((variant) => variant.id)]);
    const shipped = {
      'Variant Fulfillment Service': 'manual',
      'Variant Requires Shipping': 'TRUE',
    };
    expect(recordsOf(csv)).toEqual([
      {
        Handle: 'lawn-3-piece-suit',
        Title: 'Lawn 3-Piece Suit',
        'Body (HTML)': '<p>Printed lawn.</p><p>Dry clean only.</p>',
        Vendor: 'Zari',
        Type: 'Suits',
        Tags: 'Eid, Lawn',
        Published: 'TRUE',
        'Option1 Name': 'Size',
        'Option1 Value': 'S',
        'Option2 Name': 'Colour',
        'Option2 Value': 'Green',
        'Variant SKU': 'LAWN-S-G',
        'Variant Grams': '500',
        'Variant Inventory Tracker': 'shopify',
        'Variant Inventory Qty': '12',
        'Variant Inventory Policy': 'deny',
        ...shipped,
        'Variant Price': '4500.00',
        'Variant Compare At Price': '5500.00',
        'Variant Taxable': 'TRUE',
        'Variant Barcode': '8964000123456',
        'Image Src': `${CDN}/lawn-1.jpg`,
        'Image Position': '1',
        'Image Alt Text': 'Front',
        'Gift Card': 'FALSE',
        'SEO Title': 'Lawn suits for Eid',
        'SEO Description': 'Printed lawn three-piece suits.',
        'Variant Weight Unit': 'g',
        'Variant Tax Code': 'REDUCED',
        'Cost per item': '2000.00',
        Status: 'active',
      },
      {
        Handle: 'lawn-3-piece-suit',
        'Option1 Value': 'M',
        'Option2 Value': 'Green',
        'Variant Inventory Tracker': 'shopify',
        'Variant Inventory Qty': '0',
        'Variant Inventory Policy': 'continue',
        ...shipped,
        'Variant Price': '4500.00',
        'Variant Taxable': 'FALSE',
        'Image Src': `${CDN}/lawn-2.jpg`,
        'Image Position': '2',
        'Image Alt Text': 'Back',
        'Variant Image': `${CDN}/lawn-2.jpg`,
      },
      // An image more than it has variants takes a row of its own.
      { Handle: 'lawn-3-piece-suit', 'Image Src': `${CDN}/lawn-3.jpg`, 'Image Position': '3' },
      // Without options, Shopify's Title / Default Title; its stock not tracked.
      {
        Handle: 'chai-mug',
        Title: 'Chai Mug',
        Published: 'FALSE',
        'Option1 Name': 'Title',
        'Option1 Value': 'Default Title',
        'Variant Inventory Policy': 'deny',
        ...shipped,
        'Variant Price': '1200.00',
        'Variant Taxable': 'TRUE',
        'Gift Card': 'FALSE',
        Status: 'draft',
      },
    ]);
  });

  it('gives a file the import takes back the same, into another shop', async () => {
    const { suit, mug } = await catalog();
    const { csv } = unwrap(
      await exports.export(
        f.a,
        '',
        async () => new Map([[suit.variants[1]!.id, { quantity: 7, continueSelling: true }]]),
      ),
    );
    const imported = unwrap(await imports.import(f.b, csv));
    expect(imported).toMatchObject({ created: 2, variants: 3, images: 3, rowErrorCount: 0 });
    expect(imported.stock.map((entry) => [entry.quantity, entry.continueSelling])).toEqual([
      [7, true],
    ]);
    const copies = (await f.products.list(f.b, { first: 10 })).items;
    const byHandle = (a: { handle: string }, b: { handle: string }) =>
      a.handle.localeCompare(b.handle);
    expect(copies.map(shapeOf).sort(byHandle)).toEqual([suit, mug].map(shapeOf).sort(byHandle));
  });

  /** The shop's file, edited as a spreadsheet would: `edit` changes its rows of cells. */
  async function edited(edit: (rows: string[][], at: (heading: string) => number) => void) {
    const [headings, ...rows] = parseCsv(unwrap(await exports.export(f.a, '', null)).csv);
    edit(rows, (heading) => headings!.indexOf(heading));
    return toCsv([headings!, ...rows]);
  }

  it("updates the shop's own products from its edited file, when told to overwrite", async () => {
    const { suit, mug } = await catalog();
    const csv = await edited((rows, at) => {
      // A new title, the vendor gone, the sale over and the price of M up; a size added, with an
      // image of its own; the mug on sale.
      rows[0]![at('Title')] = 'Lawn 3-Piece Suit (Eid)';
      rows[0]![at('Vendor')] = '';
      // Search engines given the suit's own title again, and a description of the file's.
      rows[0]![at('SEO Title')] = '';
      rows[0]![at('SEO Description')] = 'Lawn suits, printed  for Eid.';
      rows[0]![at('Variant Compare At Price')] = '';
      rows[1]![at('Variant Price')] = '4800.00';
      rows[1]![at('Variant SKU')] = 'LAWN-M-G';
      const large = rows[0]!.map(() => '');
      large[at('Handle')] = 'lawn-3-piece-suit';
      large[at('Option1 Value')] = 'L';
      large[at('Option2 Value')] = 'Green';
      large[at('Variant Price')] = '4900.00';
      large[at('Variant Image')] = `${CDN}/lawn-l.jpg`;
      large[at('Image Src')] = `${CDN}/lawn-l.jpg`;
      large[at('Variant Inventory Tracker')] = 'shopify';
      large[at('Variant Inventory Qty')] = '6';
      rows.splice(3, 0, large);
      rows[4]![at('Status')] = 'active';
    });
    // Without overwrite, the shop's products stay as they are.
    expect(unwrap(await imports.import(f.a, csv))).toMatchObject({
      created: 0,
      updated: 0,
      skipped: 2,
    });
    expect(unwrap(await imports.import(f.a, csv, { dryRun: true, overwrite: true }))).toMatchObject(
      { created: 0, updated: 2, variants: 1, images: 1, skipped: 0, rowErrorCount: 0 },
    );
    expect((await f.products.get(f.a, suit.id))!.title).toBe('Lawn 3-Piece Suit');

    const done = unwrap(await imports.import(f.a, csv, { overwrite: true }));
    expect(done).toMatchObject({ updated: 2, variants: 1, images: 1, rowErrorCount: 0 });
    const after = (await f.products.get(f.a, suit.id))!;
    expect(after).toMatchObject({
      title: 'Lawn 3-Piece Suit (Eid)',
      vendor: null,
      productType: 'Suits',
      tags: ['Eid', 'Lawn'],
      seo: { title: null, description: 'Lawn suits, printed for Eid.' },
    });
    // Its variants keep their IDs; the new size is a variant of its own, shown with its image.
    expect(
      after.variants.map((variant) => [
        variant.id,
        variant.title,
        variant.price,
        variant.compareAtPrice,
        variant.sku,
        variant.mediaId,
      ]),
    ).toEqual([
      [suit.variants[0]!.id, 'S / Green', 4_500_00n, null, 'LAWN-S-G', null],
      [suit.variants[1]!.id, 'M / Green', 4_800_00n, null, 'LAWN-M-G', suit.variants[1]!.mediaId],
      [expect.any(String), 'L / Green', 4_900_00n, null, null, after.media[3]!.id],
    ]);
    expect(after.media.map((media) => media.sourceUrl)).toEqual([
      `${CDN}/lawn-1.jpg`,
      `${CDN}/lawn-2.jpg`,
      `${CDN}/lawn-3.jpg`,
      `${CDN}/lawn-l.jpg`,
    ]);
    expect((await f.products.get(f.a, mug.id))!.status).toBe('active');
    // Stock for the variant made alone: the shop's variants keep theirs.
    expect(done.stock).toEqual([
      { variantId: after.variants[2]!.id, row: 5, quantity: 6, continueSelling: false },
    ]);
  });

  it('leaves a product whose options or values the update would not take, and says why', async () => {
    const { suit, mug } = await catalog();
    const csv = await edited((rows, at) => {
      rows[0]![at('Title')] = 'Renamed';
      rows[0]![at('Option2 Name')] = 'Shade';
      rows[3]![at('Title')] = 'Chai Mug XL';
      rows[3]![at('Variant Price')] = 'a lot';
    });
    const done = unwrap(await imports.import(f.a, csv, { overwrite: true }));
    expect(done).toMatchObject({ updated: 0, rowErrorCount: 2 });
    expect(done.rowErrors).toEqual([
      {
        row: 2,
        column: 'Option1 Name',
        message:
          "The shop's product has Size, Colour and the file Size, Shade: change a product's " +
          'options in the admin, then import it',
      },
      { row: 5, column: 'Variant Price', message: expect.any(String) },
    ]);
    // Neither changed at all.
    expect((await f.products.get(f.a, suit.id))!.title).toBe('Lawn 3-Piece Suit');
    expect((await f.products.get(f.a, mug.id))!.title).toBe('Chai Mug');
  });

  it("exports what the products list's search finds, and no more than an import takes", async () => {
    await catalog();
    const drafts = unwrap(await exports.export(f.a, 'status:draft', null));
    expect([recordsOf(drafts.csv).map((record) => record.Handle), drafts.rows]).toEqual([
      ['chai-mug'],
      1,
    ]);
    // No more rows, nor characters, than an import takes, saying what to narrow.
    const message = (result: Awaited<ReturnType<ProductExportService['export']>>) =>
      result.ok ? null : result.errors[0]!.message;
    const tooMany = await exports.export(f.a, '', null, { rows: 3 });
    expect(errorsOf(tooMany)).toEqual([['query', 'TOO_MANY']]);
    expect(message(tooMany)).toBe(
      'The 2 products that match take 4 rows; a file holds at most 3, as an import takes. ' +
        'Narrow it down, such as by status, vendor, type or tag, and export the rest apart.',
    );
    const length = unwrap(await exports.export(f.a, '', null)).csv.length;
    expect(message(await exports.export(f.a, '', null, { csv: length - 1 }))).toBe(
      `The file would be ${length.toLocaleString('en')} characters; an import takes at most ` +
        `${(length - 1).toLocaleString('en')}. Narrow it down, such as by status, vendor, type ` +
        'or tag, and export the rest apart.',
    );
    // Another shop's are not among them; a shop without products has a file of headings, and
    // gives no stock to ask for.
    const none = unwrap(
      await exports.export(f.b, '', () => Promise.reject(new Error('No variants to ask for'))),
    );
    expect(none).toEqual({
      csv: expect.stringContaining('Handle,Title,Body (HTML)'),
      products: 0,
      rows: 0,
    });
  });
});
