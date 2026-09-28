import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleCandidate, toHandle } from './handle.js';
import type { ProductRecord } from './records.js';
import {
  collectionProducts,
  collections,
  productMedia,
  productOptionValues,
  productOptions,
  products,
  variants,
} from './schema.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe('handles', () => {
  it.each([
    ['Lawn 3-Piece Suit (Unstitched)', 'lawn-3-piece-suit-unstitched'],
    ['  Peshawari   Chappal!! ', 'peshawari-chappal'],
    ['Café & Chai', 'cafe-and-chai'],
    ['کھسہ', ''],
  ])('%s → %s', (title, handle) => {
    expect(toHandle(title)).toBe(handle);
  });

  it('numbers candidates within the length limit', () => {
    expect(handleCandidate('khussa', 0)).toBe('khussa');
    expect(handleCandidate('khussa', 1)).toBe('khussa-2');
    expect(handleCandidate('a'.repeat(100), 9)).toBe(`${'a'.repeat(97)}-10`);
  });
});

describe.skipIf(!server)('ProductService', () => {
  let f: CatalogFixture;
  const create = async (title: string, extra: Record<string, unknown> = {}) =>
    unwrap(await f.products.create(f.a, { title, ...extra }));
  const titles = (product: ProductRecord) => product.variants.map((variant) => variant.title);

  beforeAll(async () => {
    f = await catalogFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('matches the migrated tables', async () => {
    // Drizzle names every column, so a mismatch with the SQL migrations fails here.
    await f.db.tenant(f.a.shopId, async (tx) => {
      for (const table of [
        products,
        variants,
        productOptions,
        productOptionValues,
        productMedia,
        collections,
        collectionProducts,
      ]) {
        await tx.select().from(table).limit(0);
      }
    });
  });

  it('creates a draft product with a generated handle and one default variant', async () => {
    const product = await create('Lawn 3-Piece Suit');
    expect(product).toMatchObject({
      title: 'Lawn 3-Piece Suit',
      handle: 'lawn-3-piece-suit',
      status: 'draft',
      version: 1,
      tags: [],
      options: [],
      media: [],
    });
    expect(product.variants).toMatchObject([
      { title: 'Default Title', price: 0n, position: 1, selectedOptions: [] },
    ]);
    expect(await f.outbox()).toEqual([
      {
        event_type: 'product.created',
        aggregate_id: product.id,
        payload: { handle: 'lawn-3-piece-suit', status: 'draft', variantCount: 1 },
      },
    ]);
  });

  it('stores prices, cost and weight', async () => {
    const product = await create('Peshawari Chappal', {
      status: 'active',
      variants: [
        { price: '2,499.50', compareAtPrice: '3000', cost: '1,200', weightGrams: 850, sku: 'PC' },
      ],
    });
    expect(product.variants[0]).toMatchObject({
      price: 249_950n,
      compareAtPrice: 300_000n,
      cost: 120_000n,
      weightGrams: 850,
      sku: 'PC',
    });
  });

  it('makes a variant for every combination of option values, in order', async () => {
    const product = await create('Lawn Kurta', {
      options: [
        { name: 'Size', values: ['S', 'M'] },
        { name: 'Colour', values: ['Maroon', 'Teal'] },
      ],
    });
    expect(product.options.map((option) => [option.name, option.position])).toEqual([
      ['Size', 1],
      ['Colour', 2],
    ]);
    expect(product.options[0]!.values.map((value) => value.name)).toEqual(['S', 'M']);
    expect(titles(product)).toEqual(['S / Maroon', 'S / Teal', 'M / Maroon', 'M / Teal']);
    expect(product.variants[3]!.selectedOptions).toMatchObject([
      { name: 'Size', value: 'M' },
      { name: 'Colour', value: 'Teal' },
    ]);
    expect(product.options.flatMap((o) => o.values.map((v) => v.hasVariants))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('takes chosen combinations, matching values without regard to case', async () => {
    const product = await create('Khussa', {
      options: [{ name: 'Size', values: ['37', '38', '39'] }],
      variants: [
        { optionValues: ['37'], price: '2250' },
        { optionValues: ['39'], price: '2350' },
      ],
    });
    expect(titles(product)).toEqual(['37', '39']);
    expect(product.options[0]!.values.map((value) => [value.name, value.hasVariants])).toEqual([
      ['37', true],
      ['38', false],
      ['39', true],
    ]);
    const shawl = await create('Shawl', {
      options: [{ name: 'Colour', values: ['Maroon'] }],
      variants: [{ optionValues: ['maroon'], price: '4000' }],
    });
    expect(titles(shawl)).toEqual(['Maroon']);
  });

  it('rejects combinations that do not fit the options', async () => {
    const result = await f.products.create(f.a, {
      title: 'Kurta',
      options: [
        { name: 'Size', values: ['S', 'M'] },
        { name: 'size', values: ['L'] },
      ],
      variants: [
        { optionValues: ['S'], price: '1' },
        { optionValues: ['S', 'XL'], price: '1' },
      ],
    });
    expect(errorsOf(result)).toEqual([
      ['input.options.1.name', 'TAKEN'],
      ['input.variants.0.optionValues', 'INVALID'],
      ['input.variants.1.optionValues.1', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await f.products.create(f.a, {
          title: 'Kurta',
          options: [{ name: 'Size', values: ['S'] }],
          variants: [
            { optionValues: ['S'], price: '1' },
            { optionValues: ['s'], price: '2' },
          ],
        }),
      ),
    ).toEqual([['input.variants.1.optionValues', 'TAKEN']]);
    expect(
      errorsOf(
        await f.products.create(f.a, {
          title: 'Kurta',
          variants: [{ price: '1' }, { price: '2' }],
        }),
      ),
    ).toEqual([['input.variants', 'TOO_MANY']]);
    expect(await f.outbox()).toEqual([]);
  });

  it('limits options to three and variants to 250', async () => {
    const values = (n: number) => Array.from({ length: n }, (_, i) => `V${i + 1}`);
    expect(
      errorsOf(
        await f.products.create(f.a, {
          title: 'Too many options',
          options: ['A', 'B', 'C', 'D'].map((name) => ({ name, values: ['x'] })),
        }),
      ),
    ).toEqual([['input.options', 'TOO_MANY']]);
    expect(
      errorsOf(
        await f.products.create(f.a, {
          title: 'Too many variants',
          options: [
            { name: 'A', values: values(16) },
            { name: 'B', values: values(16) },
          ],
        }),
      ),
    ).toEqual([['input.options', 'TOO_MANY']]);
    const most = await create('Most variants', {
      options: [
        { name: 'A', values: values(10) },
        { name: 'B', values: values(25) },
      ],
    });
    expect(most.variants).toHaveLength(250);
  });

  it('numbers generated handles and rejects a taken explicit handle', async () => {
    expect((await create('Khussa')).handle).toBe('khussa');
    expect((await create('Khussa')).handle).toBe('khussa-2');
    const taken = await f.products.create(f.a, { title: 'Other', handle: 'Khussa' });
    expect(taken).toEqual({
      ok: false,
      errors: [{ field: ['input', 'handle'], code: 'TAKEN', message: 'Handle is already in use' }],
    });
  });

  it('allows the same handle in different shops', async () => {
    await create('Khussa');
    expect(unwrap(await f.products.create(f.b, { title: 'Khussa' })).handle).toBe('khussa');
  });

  it('falls back to a generic handle for titles without Latin letters', async () => {
    expect((await create('کھسہ')).handle).toBe('product');
  });

  it('reports every invalid field and writes nothing', async () => {
    const result = await f.products.create(f.a, {
      title: '   ',
      vendor: 'v'.repeat(256),
      options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
      variants: [
        { optionValues: ['S'], price: 'abc' },
        { optionValues: ['M'], price: '-5', weightGrams: -1 },
        { optionValues: ['L'], price: '' },
      ],
    });
    expect(errorsOf(result)).toEqual([
      ['input.title', 'BLANK'],
      ['input.vendor', 'TOO_LONG'],
      ['input.variants.0.price', 'INVALID'],
      ['input.variants.1.price', 'INVALID'],
      ['input.variants.1.weightGrams', 'INVALID'],
      ['input.variants.2.price', 'BLANK'],
    ]);
    if (!result.ok) expect(result.errors[0]?.message).toBe("Title can't be blank");
    expect(await f.outbox()).toEqual([]);
  });

  it('updates changed fields, bumps the version and records what changed', async () => {
    const product = await create('Lawn Suit', { vendor: 'Gul Ahmed' });
    const updated = unwrap(
      await f.products.update(f.a, {
        id: product.id,
        title: 'Lawn Suit 2026',
        status: 'active',
        vendor: null,
        tags: ['Eid', 'eid', ' Summer '],
      }),
    );
    expect(updated).toMatchObject({
      title: 'Lawn Suit 2026',
      status: 'active',
      vendor: null,
      tags: ['Eid', 'Summer'],
      version: 2,
      handle: 'lawn-suit',
    });
    expect((await f.outbox()).at(-1)).toEqual({
      event_type: 'product.updated',
      aggregate_id: product.id,
      payload: { changed: ['title', 'status', 'vendor', 'tags'], version: 2 },
    });
  });

  it('leaves the version alone when nothing changes', async () => {
    const product = await create('Lawn Suit');
    const result = await f.products.update(f.a, { id: product.id, title: 'Lawn Suit' });
    expect(unwrap(result).version).toBe(1);
    expect((await f.outbox()).map((event) => event.event_type)).toEqual(['product.created']);
  });

  it('rejects a handle that another product uses', async () => {
    await create('Khussa');
    const other = await create('Chappal');
    expect(errorsOf(await f.products.update(f.a, { id: other.id, handle: 'khussa' }))).toEqual([
      ['input.handle', 'TAKEN'],
    ]);
  });

  it('deletes a product with everything that belongs to it', async () => {
    const product = await create('Kurta', { options: [{ name: 'Size', values: ['S', 'M'] }] });
    unwrap(
      await f.media.create(f.a, product.id, [{ originalSource: 'https://cdn.example.com/k.jpg' }]),
    );
    const collection = unwrap(
      await f.collections.create(f.a, { title: 'New in', productIds: [product.id] }),
    );
    expect(unwrap(await f.products.delete(f.a, product.id))).toEqual({ id: product.id });
    expect(await f.products.get(f.a, product.id)).toBeNull();
    expect((await f.collections.get(f.a, collection.id))?.productsCount).toBe(0);
    const { rows } = await f.admin.query(
      `SELECT (SELECT count(*) FROM catalog.variants WHERE product_id = $1)::int AS variants,
              (SELECT count(*) FROM catalog.product_options WHERE product_id = $1)::int AS options,
              (SELECT count(*) FROM catalog.product_media WHERE product_id = $1)::int AS media`,
      [product.id],
    );
    expect(rows[0]).toEqual({ variants: 0, options: 0, media: 0 });
    expect((await f.outbox()).at(-1)).toMatchObject({
      event_type: 'product.deleted',
      payload: { handle: 'kurta' },
    });
    expect(errorsOf(await f.products.delete(f.a, product.id))).toEqual([['input.id', 'NOT_FOUND']]);
  });

  it('finds products by handle', async () => {
    const product = await create('Sindhi Ajrak');
    expect((await f.products.getByHandle(f.a, 'sindhi-ajrak'))?.id).toBe(product.id);
    expect(await f.products.getByHandle(f.a, 'nope')).toBeNull();
    expect(await f.products.getByHandle(f.b, 'sindhi-ajrak')).toBeNull();
  });

  it('lists tags, types and vendors in use, most used first', async () => {
    await create('One', { tags: ['eid', 'lawn'], productType: 'Unstitched', vendor: 'Karigar' });
    await create('Two', { tags: ['eid'], productType: 'Unstitched' });
    await create('Three', { tags: ['sale'], productType: 'Footwear', vendor: 'Karigar' });
    expect(await f.products.facetValues(f.a, 'tags', 10)).toEqual(['eid', 'lawn', 'sale']);
    expect(await f.products.facetValues(f.a, 'productType', 1)).toEqual(['Unstitched']);
    expect(await f.products.facetValues(f.a, 'vendor', 10)).toEqual(['Karigar']);
    expect(await f.products.facetValues(f.b, 'tags', 10)).toEqual([]);
  });

  it('finds products by Roman Urdu spelling variants and Urdu script', async () => {
    const suit = await create('Qameez Shalwar', { tags: ['لان'], vendor: 'Khaadi' });
    await create('Peshawari Chappal');
    const search = async (query: string) =>
      (await f.products.list(f.a, { first: 10, query })).items.map((p) => p.id);

    expect(await search('kameez shalvar')).toEqual([suit.id]);
    expect(await search('KAMIZ')).toEqual([suit.id]);
    expect(await search('shalwar khaadi')).toEqual([suit.id]);
    expect(await search('لان')).toEqual([suit.id]);
    expect(await search('kurta')).toEqual([]);
  });

  it('pages newest first, with variants, options and media loaded in one go', async () => {
    const first = await create('One', { options: [{ name: 'Size', values: ['S', 'M'] }] });
    const second = await create('Two');
    const third = await create('Three');
    const page1 = await f.products.list(f.a, { first: 2 });
    expect(page1.items.map((p) => p.id)).toEqual([third.id, second.id]);
    expect(page1.hasNextPage).toBe(true);
    const page2 = await f.products.list(f.a, { first: 2, after: second.id });
    expect(page2.items.map((p) => p.id)).toEqual([first.id]);
    expect(titles(page2.items[0]!)).toEqual(['S', 'M']);
    expect(page2.hasNextPage).toBe(false);
  });

  it("never reads or changes another shop's products", async () => {
    const product = await create('Khussa');
    expect(await f.products.get(f.b, product.id)).toBeNull();
    expect((await f.products.list(f.b, { first: 10 })).items).toEqual([]);
    expect(errorsOf(await f.products.update(f.b, { id: product.id, title: 'Stolen' }))).toEqual([
      ['input.id', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.products.delete(f.b, product.id))).toEqual([['input.id', 'NOT_FOUND']]);
    expect((await f.products.get(f.a, product.id))?.title).toBe('Khussa');
  });
});
