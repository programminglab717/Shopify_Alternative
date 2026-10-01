import 'reflect-metadata';
import { parseCsv } from '@hatti/csv';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProductExportService } from './product-export.service.js';
import { ProductImportService } from './product-import.service.js';
import type { ProductRecord } from './records.js';
import { SHOPIFY_PRODUCT_HEADINGS, htmlToText, textToHtml } from './shopify-csv.js';
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
