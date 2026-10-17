import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readInstagramPosts } from './instagram-posts.js';
import { ProductImportService } from './product-import.service.js';
import { catalogFixture, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();
const SPARKLES = String.fromCodePoint(0x2728);
const DASH = String.fromCharCode(0x2014);

/** Posts as Instagram's API lists a shop's media. */
const API = JSON.stringify({
  data: [
    {
      id: '1',
      media_type: 'CAROUSEL_ALBUM',
      caption:
        `Gul Lawn 3 Piece Suit ${SPARKLES}\n` +
        'Unstitched printed lawn for summer.\n' +
        'Price: Rs 4,500/- (was Rs 5,500, now on sale)\n' +
        'Colours: Mint, Rose and Ivory\n' +
        'DM to order! #lawn #summer2026 #Lawn',
      children: {
        data: [
          { media_type: 'IMAGE', media_url: 'https://cdn.example.com/gul-1.jpg' },
          { media_type: 'VIDEO', media_url: 'https://cdn.example.com/gul.mp4' },
          { media_type: 'IMAGE', media_url: 'https://cdn.example.com/gul-2.jpg' },
        ],
      },
    },
    {
      id: '2',
      media_type: 'IMAGE',
      media_url: 'https://cdn.example.com/kurta.jpg',
      caption: 'Khaddar Kurta\nSizes: S, M, L, XL\n3200 PKR',
    },
    { id: '3', media_type: 'IMAGE', media_url: 'https://cdn.example.com/x.jpg', caption: '' },
    { id: '4', media_type: 'IMAGE', caption: 'Khaddar Kurta\nRestocked soon' },
  ],
});

describe("A shop's Instagram posts (ONB-04, ADR-501)", () => {
  it('reads titles, prices, sizes, colours, hashtags and eastern wear from captions', () => {
    const file = readInstagramPosts(API);
    if (!file.ok) throw new Error(file.message);
    expect(file.rows).toBe(4);
    const [lawn, kurta, again] = file.products;
    expect(lawn).toMatchObject({
      handle: 'gul-lawn-3-piece-suit',
      row: 1,
      input: {
        title: 'Gul Lawn 3 Piece Suit',
        status: 'draft',
        tags: ['lawn', 'summer2026'],
        options: [{ name: 'Colour', values: ['Mint', 'Rose', 'Ivory'] }],
        easternWear: { stitching: 'unstitched', pieces: 3, fabrics: ['lawn'], season: 'summer' },
      },
      images: [
        { src: 'https://cdn.example.com/gul-1.jpg', alt: 'Gul Lawn 3 Piece Suit', row: 1 },
        { src: 'https://cdn.example.com/gul-2.jpg', alt: 'Gul Lawn 3 Piece Suit', row: 1 },
      ],
    });
    // On sale: the lower price, the higher compared at; a variant for each colour.
    expect(lawn!.input.variants).toEqual([
      { optionValues: ['Mint'], price: '4500', compareAtPrice: '5500' },
      { optionValues: ['Rose'], price: '4500', compareAtPrice: '5500' },
      { optionValues: ['Ivory'], price: '4500', compareAtPrice: '5500' },
    ]);
    expect(lawn!.input.description).toContain('Unstitched printed lawn for summer.');
    expect(kurta).toMatchObject({
      handle: 'khaddar-kurta',
      input: {
        options: [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }],
        easternWear: { fabrics: ['khaddar'] },
      },
    });
    expect(kurta!.input.variants?.map((variant) => variant.price)).toEqual([
      '3200',
      '3200',
      '3200',
      '3200',
    ]);
    // The same title again keeps a handle of its own; without a price, at Rs 0.
    expect(again).toMatchObject({
      handle: 'khaddar-kurta-2',
      input: { variants: [{ price: '0' }] },
    });
    expect(file.problems).toEqual([
      { row: 3, column: 'caption', message: 'The post has no caption to make a product of' },
      {
        row: 4,
        column: 'price',
        message: 'The caption names no price: priced at Rs 0 until one is set',
      },
    ]);
  });

  it("reads Instagram's own download, its text mended and its photos left to add", () => {
    const mangled = Buffer.from(`Chiffon Dupatta ${DASH} Eid edition`, 'utf8').toString('latin1');
    const file = readInstagramPosts(
      JSON.stringify([
        {
          media: [
            {
              uri: 'media/posts/202610/1.jpg',
              creation_timestamp: 1_790_000_000,
              title: `${mangled}\nRs. 2,800`,
            },
          ],
        },
      ]),
    );
    if (!file.ok) throw new Error(file.message);
    expect(file.products[0]).toMatchObject({
      input: {
        title: `Chiffon Dupatta ${DASH} Eid edition`,
        easternWear: { fabrics: ['chiffon'], season: 'festive' },
        variants: [{ price: '2800' }],
      },
      images: [],
    });
    expect(file.problems).toEqual([
      {
        row: 1,
        column: 'media',
        message:
          "Its photos are in Instagram's download, not at addresses Hatti can fetch: add them to the product",
      },
    ]);
    expect(readInstagramPosts('Handle,Title')).toMatchObject({ ok: false, code: 'INVALID' });
    expect(readInstagramPosts('{"posts": []}')).toMatchObject({ ok: false, code: 'INVALID' });
    expect(readInstagramPosts(' ')).toMatchObject({ ok: false, code: 'BLANK' });
  });
});

describe.skipIf(!server)("Importing a shop's Instagram posts (ADR-501)", () => {
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

  it('makes draft products of them, with their photos, nothing of a post without a caption', async () => {
    const dry = unwrap(await imports.import(f.a, API, { format: 'instagram', dryRun: true }));
    expect(dry).toMatchObject({ rows: 4, created: 3, variants: 8, images: 3, dryRun: true });
    expect((await f.products.list(f.a, { first: 10 })).items).toEqual([]);

    const result = unwrap(await imports.import(f.a, API, { format: 'instagram' }));
    expect(result).toMatchObject({ created: 3, variants: 8, images: 3, rowErrorCount: 2 });
    const { items } = await f.products.list(f.a, { first: 10 });
    const lawn = items.find((product) => product.handle === 'gul-lawn-3-piece-suit')!;
    expect(lawn.status).toBe('draft');
    expect(lawn.variants.map((variant) => [variant.price, variant.compareAtPrice])).toEqual([
      [450_000n, 550_000n],
      [450_000n, 550_000n],
      [450_000n, 550_000n],
    ]);
    // Posts are not a Shopify file.
    expect(await imports.import(f.a, API)).toMatchObject({ ok: false });
  });
});
