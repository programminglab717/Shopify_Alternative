import 'reflect-metadata';
import type { Tx } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CopiedVariantStock, type VariantCopy } from './product-copy.js';
import { ProductService } from './product.service.js';
import type { ProductRecord } from './records.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

/** Stock settings as the port is asked to copy them, and in which transaction. */
class Asked extends CopiedVariantStock {
  calls: { shopId: string; copies: readonly VariantCopy[] }[] = [];
  fail = false;

  async copy(tx: Tx, shopId: string, copies: readonly VariantCopy[]): Promise<void> {
    // In the duplicate's transaction: the copy's variants are there to see.
    const { rows } = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM catalog.variants
       WHERE id = ANY(${sql.param(copies.map(({ to }) => to))}::uuid[])`);
    expect(rows[0]!.n).toBe(copies.length);
    this.calls.push({ shopId, copies });
    if (this.fail) throw new Error('stock unavailable');
  }
}

describe.skipIf(!server)('A product duplicated (ADR-343)', () => {
  let f: CatalogFixture;
  let stock: Asked;
  let products: ProductService;
  const create = async (title: string, extra: Record<string, unknown> = {}) =>
    unwrap(await f.products.create(f.a, { title, ...extra }));
  const variantsOf = (product: ProductRecord) =>
    product.variants.map(({ title, sku, barcode, price, compareAtPrice, cost, weightGrams }) => ({
      title,
      sku,
      barcode,
      price,
      compareAtPrice,
      cost,
      weightGrams,
    }));

  /** A lawn suit in three sizes and two colours, priced and described. */
  const lawnSuit = () =>
    create('Lawn Suit - Firozi', {
      status: 'active',
      description: 'Three pieces of printed lawn.',
      vendor: 'Zari',
      productType: 'Unstitched',
      tags: ['lawn', 'summer'],
      seo: { title: 'Firozi lawn suit', description: 'Printed lawn, three pieces' },
      options: [
        { name: 'Size', values: ['S', 'M', 'L'] },
        { name: 'Colour', values: ['Firozi', 'Maroon'] },
      ],
      variants: ['S', 'M', 'L'].flatMap((size, index) =>
        ['Firozi', 'Maroon'].map((colour) => ({
          optionValues: [size, colour],
          price: String(4500 + index * 100),
          compareAtPrice: '5500',
          cost: '2100',
          weightGrams: 600,
          taxable: false,
          sku: `LAWN-${size}-${colour}`,
          barcode: `880${index}`,
        })),
      ),
    });

  beforeAll(async () => {
    f = await catalogFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    stock = new Asked();
    products = new ProductService(f.db, stock);
  });

  it('copies its words, options and variants with their prices, not their SKUs, as asked', async () => {
    const original = await lawnSuit();
    const copy = unwrap(
      await products.duplicate(f.a, {
        productId: original.id,
        newTitle: 'Lawn Suit - Maroon',
        newStatus: 'draft',
      }),
    );

    expect(copy.id).not.toBe(original.id);
    expect(copy).toMatchObject({
      title: 'Lawn Suit - Maroon',
      handle: 'lawn-suit-maroon',
      status: 'draft',
      description: 'Three pieces of printed lawn.',
      vendor: 'Zari',
      productType: 'Unstitched',
      tags: ['lawn', 'summer'],
      seo: { title: 'Firozi lawn suit', description: 'Printed lawn, three pieces' },
      media: [],
    });
    expect(
      copy.options.map(({ name, values }) => [name, values.map((value) => value.name)]),
    ).toEqual([
      ['Size', ['S', 'M', 'L']],
      ['Colour', ['Firozi', 'Maroon']],
    ]);
    expect(variantsOf(copy)).toEqual(
      variantsOf(original).map((variant) => ({ ...variant, sku: null, barcode: null })),
    );
    expect(copy.variants.every((variant) => !variant.taxable)).toBe(true);
    expect(copy.variants.map((variant) => variant.selectedOptions.map((o) => o.value))).toEqual(
      original.variants.map((variant) => variant.selectedOptions.map((o) => o.value)),
    );

    // Its stock settings asked to follow, variant by variant, in order.
    expect(stock.calls).toEqual([
      {
        shopId: f.a.shopId,
        copies: original.variants.map((variant, index) => ({
          from: variant.id,
          to: copy.variants[index]!.id,
          productId: copy.id,
        })),
      },
    ]);
    // The product itself is as it was; the copy is told of as a product made.
    expect(variantsOf((await f.products.get(f.a, original.id))!)).toEqual(variantsOf(original));
    const created = (await f.outbox()).filter((row) => row.event_type === 'product.created');
    expect(created.at(-1)).toMatchObject({
      aggregate_id: copy.id,
      payload: { handle: 'lawn-suit-maroon', status: 'draft', variantCount: 6 },
    });
  });

  it("keeps the product's own status unless told, and numbers a handle taken", async () => {
    const original = await lawnSuit();
    const copy = unwrap(
      await products.duplicate(f.a, { productId: original.id, newTitle: 'Lawn Suit - Firozi' }),
    );
    expect(copy).toMatchObject({ status: 'active', handle: 'lawn-suit-firozi-2' });

    const plain = await create('Khussa', { variants: [{ price: '2250', sku: 'KH-1' }] });
    const again = unwrap(
      await products.duplicate(f.a, { productId: plain.id, newTitle: '  Gold Khussa ' }),
    );
    expect(again).toMatchObject({ title: 'Gold Khussa', status: 'draft', options: [] });
    expect(variantsOf(again)).toEqual([{ ...variantsOf(plain)[0], sku: null, barcode: null }]);
  });

  it('copies its photos and videos only when asked, each made again, its variants showing theirs', async () => {
    const original = await lawnSuit();
    const { mediaIds } = unwrap(
      await f.media.create(f.a, original.id, [
        { originalSource: 'https://cdn.example.pk/firozi-front.jpg', alt: 'Front' },
        { originalSource: 'https://cdn.example.pk/firozi-back.jpg', alt: 'Back' },
      ]),
    );
    unwrap(
      await f.variants.bulkUpdate(f.a, original.id, [
        { id: original.variants[1]!.id, mediaId: mediaIds[1]! },
      ]),
    );

    const without = unwrap(
      await products.duplicate(f.a, { productId: original.id, newTitle: 'Without photos' }),
    );
    expect(without.media).toEqual([]);
    expect(without.variants.map((variant) => variant.mediaId)).toEqual(
      original.variants.map(() => null),
    );

    const copy = unwrap(
      await products.duplicate(f.a, {
        productId: original.id,
        newTitle: 'With photos',
        includeImages: true,
      }),
    );
    expect(
      copy.media.map(({ sourceUrl, alt, position, status }) => ({
        sourceUrl,
        alt,
        position,
        status,
      })),
    ).toEqual([
      {
        sourceUrl: 'https://cdn.example.pk/firozi-front.jpg',
        alt: 'Front',
        position: 1,
        status: 'uploaded',
      },
      {
        sourceUrl: 'https://cdn.example.pk/firozi-back.jpg',
        alt: 'Back',
        position: 2,
        status: 'uploaded',
      },
    ]);
    expect(copy.media.some((media) => mediaIds.includes(media.id))).toBe(false);
    expect(copy.variants.map((variant) => variant.mediaId)).toEqual(
      original.variants.map((_, index) => (index === 1 ? copy.media[1]!.id : null)),
    );
    // The product's own are as they were.
    expect((await f.products.get(f.a, original.id))!.media.map((media) => media.id)).toEqual(
      mediaIds,
    );
  });

  it('puts the copy last in the manual collections the product is in, and smart ones by their rules', async () => {
    const original = await lawnSuit();
    const other = await create('Chiffon Dupatta');
    const manual = unwrap(
      await f.collections.create(f.a, { title: 'Eid Edit', productIds: [original.id, other.id] }),
    );
    const elsewhere = unwrap(
      await f.collections.create(f.a, { title: 'Shoes', productIds: [other.id] }),
    );
    const smart = unwrap(
      await f.collections.create(f.a, {
        title: 'Lawn',
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: 'tag', relation: 'equals', condition: 'lawn' }],
        },
      }),
    );

    const copy = unwrap(
      await products.duplicate(f.a, { productId: original.id, newTitle: 'Lawn Suit - Maroon' }),
    );
    const members = async (id: string) =>
      (await f.collections.products(f.a, id, { first: 50, after: null }))!.items.map(
        (item) => item.id,
      );
    expect(await members(manual.id)).toEqual([original.id, other.id, copy.id]);
    expect(await members(elsewhere.id)).toEqual([other.id]);
    expect((await members(smart.id)).sort()).toEqual([original.id, copy.id].sort());
    const updated = (await f.outbox()).filter((row) => row.event_type === 'collection.updated');
    expect(updated.map((row) => row.aggregate_id)).toEqual([manual.id]);
  });

  it('refuses a blank title or a product not found, and writes nothing when its stock cannot follow', async () => {
    const original = await lawnSuit();
    expect(
      errorsOf(await products.duplicate(f.a, { productId: original.id, newTitle: '  ' })),
    ).toEqual([['newTitle', 'BLANK']]);
    expect(
      errorsOf(await products.duplicate(f.b, { productId: original.id, newTitle: 'Elsewhere' })),
    ).toEqual([['productId', 'NOT_FOUND']]);

    stock.fail = true;
    await expect(
      products.duplicate(f.a, { productId: original.id, newTitle: 'Lawn Suit - Maroon' }),
    ).rejects.toThrow('stock unavailable');
    const { items } = await f.products.list(f.a, { first: 10 });
    expect(items.map((item) => item.title)).toEqual(['Lawn Suit - Firozi']);
  });
});
