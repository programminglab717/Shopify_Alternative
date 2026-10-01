import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProductRecord } from './records.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('options, variants and media', () => {
  let f: CatalogFixture;
  const titles = (product: ProductRecord) => product.variants.map((variant) => variant.title);
  const byTitle = (product: ProductRecord, title: string) =>
    product.variants.find((variant) => variant.title === title)!;
  const kurta = async () =>
    unwrap(
      await f.products.create(f.a, {
        title: 'Lawn Kurta',
        options: [
          { name: 'Size', values: ['S', 'M'] },
          { name: 'Colour', values: ['Maroon', 'Teal'] },
        ],
      }),
    );
  const events = async () => (await f.outbox()).map((event) => event.event_type);

  beforeAll(async () => {
    f = await catalogFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  describe('bulk variants', () => {
    it('adds variants, and the option values they name', async () => {
      const product = await kurta();
      const result = unwrap(
        await f.variants.bulkCreate(f.a, product.id, [
          { optionValues: ['L', 'maroon'], price: '2,650', sku: 'K-L-M' },
          { optionValues: ['XL', 'Teal'], price: '2800', taxable: false },
        ]),
      );
      expect(titles(result.product)).toEqual([
        'S / Maroon',
        'S / Teal',
        'M / Maroon',
        'M / Teal',
        'L / Maroon',
        'XL / Teal',
      ]);
      expect(result.product.options[0]!.values.map((value) => value.name)).toEqual([
        'S',
        'M',
        'L',
        'XL',
      ]);
      expect(result.variantIds).toHaveLength(2);
      expect(byTitle(result.product, 'L / Maroon')).toMatchObject({
        price: 265_000n,
        sku: 'K-L-M',
        taxable: true,
        position: 5,
      });
      // Its price includes no sales tax.
      expect(byTitle(result.product, 'XL / Teal').taxable).toBe(false);
      expect(result.product.version).toBe(2);
      expect((await f.outbox()).at(-1)).toMatchObject({
        event_type: 'product.updated',
        payload: { changed: ['options', 'variants'], version: 2 },
      });
    });

    it('refuses combinations that exist, and products without options', async () => {
      const product = await kurta();
      expect(
        errorsOf(
          await f.variants.bulkCreate(f.a, product.id, [
            { optionValues: ['s', 'MAROON'], price: '1' },
            { optionValues: ['L', 'Teal'], price: '1' },
            { optionValues: ['L', 'Teal'], price: '1' },
          ]),
        ),
      ).toEqual([
        ['variants.0.optionValues', 'TAKEN'],
        ['variants.2.optionValues', 'TAKEN'],
      ]);
      const plain = unwrap(await f.products.create(f.a, { title: 'Ajrak' }));
      expect(errorsOf(await f.variants.bulkCreate(f.a, plain.id, [{ price: '1' }]))).toEqual([
        ['variants', 'INVALID'],
      ]);
    });

    it('updates fields, clears them with null and leaves the rest', async () => {
      const product = await kurta();
      const variant = byTitle(product, 'M / Teal');
      const result = unwrap(
        await f.variants.bulkUpdate(f.a, product.id, [
          {
            id: variant.id,
            price: '3,100',
            compareAtPrice: '3,600',
            cost: '1,400',
            sku: 'K-M-T',
            weightGrams: 350,
            taxable: false,
            taxCode: ' REDUCED ',
          },
        ]),
      );
      expect(byTitle(result.product, 'M / Teal')).toMatchObject({
        price: 310_000n,
        compareAtPrice: 360_000n,
        cost: 140_000n,
        sku: 'K-M-T',
        weightGrams: 350,
        taxable: false,
        taxCode: 'REDUCED',
      });
      // A tax code is a category's, as the tax module names them.
      expect(
        errorsOf(
          await f.variants.bulkUpdate(f.a, product.id, [{ id: variant.id, taxCode: 'a b' }]),
        ),
      ).toEqual([['variants.0.taxCode', 'INVALID']]);
      const cleared = unwrap(
        await f.variants.bulkUpdate(f.a, product.id, [
          { id: variant.id, compareAtPrice: null, sku: null, taxCode: ' ' },
        ]),
      );
      expect(byTitle(cleared.product, 'M / Teal')).toMatchObject({
        price: 310_000n,
        compareAtPrice: null,
        sku: null,
        cost: 140_000n,
        taxable: false,
        taxCode: null,
      });
      expect(cleared.product.version).toBe(3);
    });

    it('lets two variants swap option values in one call', async () => {
      const product = await kurta();
      const small = byTitle(product, 'S / Maroon');
      const medium = byTitle(product, 'M / Maroon');
      const result = unwrap(
        await f.variants.bulkUpdate(f.a, product.id, [
          { id: small.id, optionValues: ['M', 'Maroon'] },
          { id: medium.id, optionValues: ['S', 'Maroon'] },
        ]),
      );
      const after = new Map(result.product.variants.map((variant) => [variant.id, variant.title]));
      expect(after.get(small.id)).toBe('M / Maroon');
      expect(after.get(medium.id)).toBe('S / Maroon');
    });

    it('refuses two variants with the same values, and variants of other products', async () => {
      const product = await kurta();
      const other = await kurta();
      expect(
        errorsOf(
          await f.variants.bulkUpdate(f.a, product.id, [
            { id: byTitle(product, 'S / Maroon').id, optionValues: ['M', 'Teal'] },
          ]),
        ),
      ).toEqual([['variants.0.optionValues', 'TAKEN']]);
      expect(
        errorsOf(
          await f.variants.bulkUpdate(f.a, product.id, [
            { id: other.variants[0]!.id, price: '1' },
            { id: byTitle(product, 'S / Teal').id, price: 'free' },
          ]),
        ),
      ).toEqual([['variants.1.price', 'INVALID']]);
      expect(
        errorsOf(
          await f.variants.bulkUpdate(f.a, product.id, [{ id: other.variants[0]!.id, price: '1' }]),
        ),
      ).toEqual([['variants.0.id', 'NOT_FOUND']]);
    });

    it('deletes variants, keeping at least one', async () => {
      const product = await kurta();
      const doomed = [byTitle(product, 'S / Maroon').id, byTitle(product, 'M / Teal').id];
      const result = unwrap(await f.variants.bulkDelete(f.a, product.id, doomed));
      expect(titles(result)).toEqual(['S / Teal', 'M / Maroon']);
      expect(result.variants.map((variant) => variant.position)).toEqual([1, 2]);
      expect(
        errorsOf(
          await f.variants.bulkDelete(
            f.a,
            product.id,
            result.variants.map((variant) => variant.id),
          ),
        ),
      ).toEqual([['variantsIds', 'TOO_FEW']]);
    });
  });

  describe('options', () => {
    it("gives existing variants each new option's first value", async () => {
      const product = unwrap(
        await f.products.create(f.a, {
          title: 'Khussa',
          options: [{ name: 'Size', values: ['37', '38'] }],
        }),
      );
      const result = unwrap(
        await f.options.create(f.a, product.id, [{ name: 'Colour', values: ['Gold', 'Silver'] }]),
      );
      expect(titles(result)).toEqual(['37 / Gold', '38 / Gold']);
      expect(result.options.map((option) => [option.name, option.position])).toEqual([
        ['Size', 1],
        ['Colour', 2],
      ]);
    });

    it('can add a variant for every missing combination', async () => {
      const product = unwrap(
        await f.products.create(f.a, {
          title: 'Chappal',
          variants: [{ price: '3,499', cost: '1,900', taxable: false }],
        }),
      );
      expect(titles(product)).toEqual(['Default Title']);
      const result = unwrap(
        await f.options.create(
          f.a,
          product.id,
          [{ name: 'Size', values: ['8', '9', '10'] }],
          'create',
        ),
      );
      expect(titles(result)).toEqual(['8', '9', '10']);
      expect(
        result.variants.map((variant) => [variant.price, variant.cost, variant.taxable]),
      ).toEqual([
        [349_900n, 190_000n, false],
        [349_900n, 190_000n, false],
        [349_900n, 190_000n, false],
      ]);
    });

    it('refuses a fourth option and a name already used', async () => {
      const product = await kurta();
      expect(
        errorsOf(
          await f.options.create(f.a, product.id, [
            { name: 'size', values: ['x'] },
            { name: 'Fabric', values: ['Lawn'] },
          ]),
        ),
      ).toEqual([
        ['options', 'TOO_MANY'],
        ['options.0.name', 'TAKEN'],
      ]);
    });

    it('renames an option and adds, renames and deletes values', async () => {
      const product = await kurta();
      const colour = product.options[1]!;
      unwrap(
        await f.variants.bulkDelete(f.a, product.id, [
          byTitle(product, 'S / Teal').id,
          byTitle(product, 'M / Teal').id,
        ]),
      );
      const result = unwrap(
        await f.options.update(f.a, product.id, {
          optionId: colour.id,
          name: 'Color',
          valuesToAdd: ['Black'],
          valuesToRename: [{ id: colour.values[0]!.id, name: 'Deep Maroon' }],
          valuesToDelete: [colour.values[1]!.id],
        }),
      );
      expect(result.options[1]).toMatchObject({ name: 'Color' });
      expect(result.options[1]!.values.map((value) => [value.name, value.position])).toEqual([
        ['Deep Maroon', 1],
        ['Black', 2],
      ]);
      expect(titles(result)).toEqual(['S / Deep Maroon', 'M / Deep Maroon']);
    });

    it('refuses to delete a value variants use, or to leave an option empty', async () => {
      const product = await kurta();
      const size = product.options[0]!;
      expect(
        errorsOf(
          await f.options.update(f.a, product.id, {
            optionId: size.id,
            valuesToDelete: [size.values[0]!.id],
          }),
        ),
      ).toEqual([['optionValuesToDelete.0', 'IN_USE']]);
      expect(
        errorsOf(
          await f.options.update(f.a, product.id, {
            optionId: size.id,
            valuesToRename: [{ id: size.values[0]!.id, name: 'M' }],
          }),
        ),
      ).toEqual([['optionValuesToUpdate', 'TAKEN']]);
    });

    it('moves an option, and variant titles follow', async () => {
      const product = await kurta();
      const result = unwrap(
        await f.options.update(f.a, product.id, { optionId: product.options[1]!.id, position: 1 }),
      );
      expect(result.options.map((option) => option.name)).toEqual(['Colour', 'Size']);
      expect(titles(result)).toEqual(['Maroon / S', 'Teal / S', 'Maroon / M', 'Teal / M']);
      expect(result.variants[0]!.selectedOptions.map((selected) => selected.name)).toEqual([
        'Colour',
        'Size',
      ]);
    });

    it('deletes an option unless variants would then be the same', async () => {
      const product = await kurta();
      expect(errorsOf(await f.options.delete(f.a, product.id, [product.options[0]!.id]))).toEqual([
        ['options', 'INVALID'],
      ]);
      unwrap(
        await f.variants.bulkDelete(f.a, product.id, [
          byTitle(product, 'M / Maroon').id,
          byTitle(product, 'M / Teal').id,
        ]),
      );
      const result = unwrap(await f.options.delete(f.a, product.id, [product.options[0]!.id]));
      expect(result.deletedIds).toEqual([product.options[0]!.id]);
      expect(result.product.options.map((option) => [option.name, option.position])).toEqual([
        ['Colour', 1],
      ]);
      expect(titles(result.product)).toEqual(['Maroon', 'Teal']);
    });

    it('gives the last variant its default title when the last option goes', async () => {
      const product = unwrap(
        await f.products.create(f.a, {
          title: 'Attar',
          options: [{ name: 'Size', values: ['6 ml'] }],
        }),
      );
      const result = unwrap(await f.options.delete(f.a, product.id, [product.options[0]!.id]));
      expect(result.product.options).toEqual([]);
      expect(titles(result.product)).toEqual(['Default Title']);
    });
  });

  describe('media', () => {
    it('adds images by https URL, in order, and edits their alt text', async () => {
      const product = await kurta();
      expect(
        errorsOf(
          await f.media.create(f.a, product.id, [
            { originalSource: 'http://insecure.example.com/a.jpg' },
          ]),
        ),
      ).toEqual([['media.0.originalSource', 'INVALID']]);
      const created = unwrap(
        await f.media.create(f.a, product.id, [
          { originalSource: 'https://cdn.example.com/front.jpg', alt: 'Front' },
          { originalSource: 'https://cdn.example.com/back.jpg' },
        ]),
      );
      expect(
        created.product.media.map((media) => [media.alt, media.position, media.status]),
      ).toEqual([
        ['Front', 1, 'uploaded'],
        ['', 2, 'uploaded'],
      ]);
      const [front, back] = created.mediaIds;
      const updated = unwrap(
        await f.media.update(f.a, product.id, [{ id: back!, alt: 'Back, with embroidery' }]),
      );
      expect(updated.media.map((media) => media.alt)).toEqual(['Front', 'Back, with embroidery']);
      const reordered = unwrap(
        await f.media.reorder(f.a, product.id, [{ id: back!, newPosition: 1 }]),
      );
      expect(reordered.media.map((media) => media.id)).toEqual([back, front]);
      expect(reordered.media.map((media) => media.position)).toEqual([1, 2]);
    });

    it('shows an image for a variant, and clears it when the image goes', async () => {
      const product = await kurta();
      const { mediaIds } = unwrap(
        await f.media.create(f.a, product.id, [
          { originalSource: 'https://cdn.example.com/maroon.jpg' },
          { originalSource: 'https://cdn.example.com/teal.jpg' },
        ]),
      );
      const variant = byTitle(product, 'S / Maroon');
      const withImage = unwrap(
        await f.variants.bulkUpdate(f.a, product.id, [{ id: variant.id, mediaId: mediaIds[0]! }]),
      );
      expect(byTitle(withImage.product, 'S / Maroon').mediaId).toBe(mediaIds[0]);
      const other = await kurta();
      expect(
        errorsOf(
          await f.variants.bulkUpdate(f.a, other.id, [
            { id: other.variants[0]!.id, mediaId: mediaIds[0]! },
          ]),
        ),
      ).toEqual([['variants.0.mediaId', 'NOT_FOUND']]);
      const result = unwrap(await f.media.delete(f.a, product.id, [mediaIds[0]!]));
      expect(result.product.media.map((media) => [media.id, media.position])).toEqual([
        [mediaIds[1], 1],
      ]);
      expect(byTitle(result.product, 'S / Maroon').mediaId).toBeNull();
    });
  });

  it("never touches another shop's product parts", async () => {
    const product = await kurta();
    const variant = product.variants[0]!;
    expect(
      errorsOf(await f.variants.bulkUpdate(f.b, product.id, [{ id: variant.id, price: '1' }])),
    ).toEqual([['productId', 'NOT_FOUND']]);
    expect(errorsOf(await f.variants.bulkDelete(f.b, product.id, [variant.id]))).toEqual([
      ['productId', 'NOT_FOUND'],
    ]);
    expect(
      errorsOf(await f.options.create(f.b, product.id, [{ name: 'Fabric', values: ['Lawn'] }])),
    ).toEqual([['productId', 'NOT_FOUND']]);
    expect(
      errorsOf(
        await f.media.create(f.b, product.id, [
          { originalSource: 'https://cdn.example.com/x.jpg' },
        ]),
      ),
    ).toEqual([['productId', 'NOT_FOUND']]);
    expect((await f.products.get(f.a, product.id))?.version).toBe(1);
    expect(await events()).toEqual(['product.created']);
  });
});
