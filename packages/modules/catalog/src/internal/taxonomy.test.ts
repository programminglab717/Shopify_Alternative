import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readShopifyProducts } from './shopify-csv.js';
import { PRODUCT_CATEGORIES, productCategoryOf } from './taxonomy.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe('Product taxonomy (CAT-18, ADR-483)', () => {
  it("finds a category by its path in Google's taxonomy, however it is spaced or cased", () => {
    expect(productCategoryOf('apparel & accessories>clothing >  Dresses')).toBe(
      'Apparel & Accessories > Clothing > Dresses',
    );
    expect(productCategoryOf('Apparel & Accessories > Shoes')).toBe(
      'Apparel & Accessories > Shoes',
    );
    expect(productCategoryOf('Vehicles & Parts')).toBeNull();
    expect(productCategoryOf('')).toBeNull();
    // Each once.
    expect(new Set(PRODUCT_CATEGORIES).size).toBe(PRODUCT_CATEGORIES.length);
  });

  it("reads Shopify's Product Category and Google Shopping condition columns", () => {
    const file = readShopifyProducts(
      [
        'Handle,Title,Product Category,Google Shopping / Condition,Variant Price',
        'lawn-suit,Lawn Suit,Apparel & Accessories > Clothing > Dresses,Used,4990',
        'mug,Mug,Home & Garden > Kitchen & Dining > Tableware,new,900',
      ].join('\n'),
    );
    if (!file.ok) throw new Error(file.message);
    expect(file.products[0]!.input).toMatchObject({
      category: 'Apparel & Accessories > Clothing > Dresses',
      condition: 'used',
    });
    // A category Hatti doesn't offer is left out; the product goes in.
    expect(file.products[1]!.input.category).toBeUndefined();
    expect(file.products[1]!.input.condition).toBe('new');
  });
});

describe.skipIf(!server)('A product’s category and condition (ADR-483)', () => {
  let f: CatalogFixture;

  beforeAll(async () => {
    f = await catalogFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('keeps one of Hatti’s categories, new unless said, changed, cleared and copied', async () => {
    const plain = unwrap(await f.products.create(f.a, { title: 'Mug' }));
    expect([plain.category, plain.condition]).toEqual([null, 'new']);

    const suit = unwrap(
      await f.products.create(f.a, {
        title: 'Bridal Lehenga',
        category:
          'apparel & accessories > clothing > traditional & ceremonial clothing > saris & lehengas',
        condition: 'used',
      }),
    );
    expect(suit.category).toBe(
      'Apparel & Accessories > Clothing > Traditional & Ceremonial Clothing > Saris & Lehengas',
    );
    expect(suit.condition).toBe('used');
    expect((await f.products.get(f.a, suit.id))?.condition).toBe('used');

    expect(
      errorsOf(await f.products.create(f.a, { title: 'Car', category: 'Vehicles & Parts' })),
    ).toEqual([['input.category', 'INVALID']]);
    expect(
      errorsOf(
        await f.products.update(f.a, {
          id: suit.id,
          condition: 'broken' as unknown as 'new',
        }),
      ),
    ).toEqual([['input.condition', 'INVALID']]);

    const updated = unwrap(
      await f.products.update(f.a, { id: suit.id, condition: 'refurbished', category: '' }),
    );
    expect([updated.category, updated.condition]).toEqual([null, 'refurbished']);
    // Left out, each stays as it is.
    const titled = unwrap(await f.products.update(f.a, { id: suit.id, title: 'Lehenga' }));
    expect(titled.condition).toBe('refurbished');

    unwrap(
      await f.products.update(f.a, { id: suit.id, category: 'Apparel & Accessories > Clothing' }),
    );
    const copy = unwrap(
      await f.products.duplicate(f.a, { productId: suit.id, newTitle: 'Lehenga 2' }),
    );
    expect([copy.category, copy.condition]).toEqual([
      'Apparel & Accessories > Clothing',
      'refurbished',
    ]);
  });
});
