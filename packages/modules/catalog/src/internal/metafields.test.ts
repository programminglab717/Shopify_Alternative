import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  METAFIELD_LIMITS,
  MetafieldEvents,
  MetafieldService,
  metafieldValueOf,
  shownMetafieldsIn,
} from './metafields.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe('Metafield values (CAT-06, ADR-489)', () => {
  it('keeps each type in its standard form, and refuses what is not of its type', () => {
    const kept = (type: Parameters<typeof metafieldValueOf>[0], value: string) => {
      const result = metafieldValueOf(type, value);
      return result.ok ? result.value : `!${result.message}`;
    };
    expect(kept('single_line_text_field', ' 100% lawn ')).toBe('100% lawn');
    expect(kept('single_line_text_field', 'two\nlines')).toBe('!must be one line');
    expect(kept('multi_line_text_field', 'Hand wash.\nDry in shade.')).toBe(
      'Hand wash.\nDry in shade.',
    );
    expect(kept('number_integer', '+007')).toBe('7');
    expect(kept('number_integer', '1.5')).toBe('!must be a whole number');
    expect(kept('number_decimal', '02.500')).toBe('2.5');
    expect(kept('number_decimal', '3')).toBe('3.0');
    expect(kept('boolean', 'yes')).toBe('!must be true or false');
    expect(kept('date', '2026-02-30')).toBe('!must be a date: YYYY-MM-DD');
    expect(kept('date', '2026-08-14')).toBe('2026-08-14');
    expect(kept('date_time', '2026-08-14T09:00:00+05:00')).toBe('2026-08-14T04:00:00.000Z');
    expect(kept('url', 'javascript:alert(1)')).toBe('!must be a web address starting https://');
    expect(kept('color', '#0F766E')).toBe('#0f766e');
    expect(kept('json', ' { "care": [ "hand wash" ] } ')).toBe('{"care":["hand wash"]}');
    expect(kept('json', '{nope')).toBe('!must be JSON');
    expect(kept('list.single_line_text_field', '[" Lawn ", "Chiffon"]')).toBe('["Lawn","Chiffon"]');
    expect(kept('list.single_line_text_field', '"Lawn"')).toBe(
      '!must be a JSON list of lines: ["Lawn", "Chiffon"]',
    );
    expect(kept('single_line_text_field', '   ')).toBe("!can't be blank");
  });
});

describe.skipIf(!server)('Metafields (CAT-06, ADR-489)', () => {
  let f: CatalogFixture;
  let metafields: MetafieldService;

  const product = async (title: string, tenant = f.a) =>
    unwrap(await f.products.create(tenant, { title, status: 'active' }));
  const events = async () =>
    (await f.outbox()).filter((event) => event.event_type === MetafieldEvents.Updated);

  beforeAll(async () => {
    f = await catalogFixture(server!);
    metafields = new MetafieldService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM catalog.metafield_definitions');
  });

  it("sets a product's, a variant's and a collection's metafields, all or none, and reads them", async () => {
    const kurta = await product('Lawn kurta');
    const variant = kurta.variants[0]!.id;
    const eid = unwrap(await f.collections.create(f.a, { title: 'Eid' }));
    const set = unwrap(
      await metafields.set(f.a, [
        {
          owner: { type: 'product', id: kurta.id },
          namespace: 'custom',
          key: 'care',
          type: 'multi_line_text_field',
          value: 'Hand wash.\nDry in shade.',
        },
        {
          owner: { type: 'variant', id: variant },
          namespace: 'custom',
          key: 'length_in',
          type: 'number_decimal',
          value: '42.50',
        },
        {
          owner: { type: 'collection', id: eid.id },
          namespace: 'custom',
          key: 'banner_colour',
          type: 'color',
          value: '#0F766E',
        },
      ]),
    );
    expect(set.map((each) => [each.owner.type, each.key, each.value])).toEqual([
      ['product', 'care', 'Hand wash.\nDry in shade.'],
      ['variant', 'length_in', '42.5'],
      ['collection', 'banner_colour', '#0f766e'],
    ]);
    // The pages that show them are rebuilt: the product, its variant's too, and the collection.
    expect((await events()).map((event) => event.payload)).toEqual([
      { productIds: [kurta.id], collectionIds: [eid.id] },
    ]);
    // Set again: changed in place.
    unwrap(
      await metafields.set(f.a, [
        {
          owner: { type: 'product', id: kurta.id },
          namespace: 'custom',
          key: 'care',
          type: 'multi_line_text_field',
          value: 'Dry clean only.',
        },
      ]),
    );
    const mine = await metafields.ofOwners(f.a, 'product', [kurta.id]);
    expect(mine.get(kurta.id)!.map((each) => each.value)).toEqual(['Dry clean only.']);
    expect(await metafields.ofOwners(f.b, 'product', [kurta.id])).toEqual(new Map());
    const shown = await f.db.tenant(f.a.shopId, (tx) =>
      shownMetafieldsIn(tx, f.a.shopId, 'variant', [variant]),
    );
    expect(shown.get(variant)).toEqual({
      custom: { length_in: { type: 'number_decimal', value: '42.5' } },
    });

    // One refused, none set: another shop's product, a bad value, Hatti's own namespace.
    const other = await product('Not ours', f.b);
    const refused = await metafields.set(f.a, [
      {
        owner: { type: 'product', id: kurta.id },
        namespace: 'custom',
        key: 'fit',
        type: 'single_line_text_field',
        value: 'Relaxed',
      },
      {
        owner: { type: 'product', id: other.id },
        namespace: 'custom',
        key: 'fit',
        type: 'single_line_text_field',
        value: 'Relaxed',
      },
      {
        owner: { type: 'product', id: kurta.id },
        namespace: 'custom',
        key: 'pieces',
        type: 'number_integer',
        value: 'three',
      },
      {
        owner: { type: 'product', id: kurta.id },
        namespace: 'hatti',
        key: 'fabric',
        type: 'single_line_text_field',
        value: 'Lawn',
      },
      { owner: { type: 'product', id: kurta.id }, namespace: 'custom', key: 'x1', value: 'y' },
    ]);
    expect(errorsOf(refused)).toEqual([
      ['metafields.1.ownerId', 'NOT_FOUND'],
      ['metafields.2.value', 'INVALID'],
      ['metafields.3.namespace', 'INVALID'],
      ['metafields.4.type', 'BLANK'],
    ]);
    expect((await metafields.ofOwners(f.a, 'product', [kurta.id])).get(kurta.id)).toHaveLength(1);

    // Deleted by owner, namespace and key; those not found are left out.
    const deleted = unwrap(
      await metafields.delete(f.a, [
        { owner: { type: 'product', id: kurta.id }, namespace: 'custom', key: 'care' },
        { owner: { type: 'product', id: kurta.id }, namespace: 'custom', key: 'nothing' },
      ]),
    );
    expect(deleted.map((each) => each.key)).toEqual(['care']);
    // And go with their owner.
    unwrap(await f.products.delete(f.a, kurta.id));
    const { rows } = await f.admin.query('SELECT count(*)::int AS n FROM catalog.metafields');
    expect(rows[0].n).toBe(1);
  });

  it("defines the shop's own fields, whose type every value then takes", async () => {
    const kurta = await product('Lawn kurta');
    unwrap(
      await metafields.set(f.a, [
        {
          owner: { type: 'product', id: kurta.id },
          namespace: 'custom',
          key: 'pieces',
          type: 'single_line_text_field',
          value: 'Three',
        },
      ]),
    );
    // Values of another type stand in its way.
    expect(
      errorsOf(
        await metafields.createDefinition(f.a, {
          ownerType: 'product',
          namespace: 'custom',
          key: 'pieces',
          type: 'number_integer',
          name: 'Pieces',
        }),
      ),
    ).toEqual([['type', 'INVALID']]);
    const care = unwrap(
      await metafields.createDefinition(f.a, {
        ownerType: 'product',
        namespace: 'custom',
        key: 'care',
        type: 'multi_line_text_field',
        name: 'Care instructions',
        description: 'How to wash it',
      }),
    );
    expect(care).toMatchObject({
      ownerType: 'product',
      type: 'multi_line_text_field',
      valuesCount: 0,
    });
    expect(
      errorsOf(
        await metafields.createDefinition(f.a, {
          ownerType: 'product',
          namespace: 'custom',
          key: 'care',
          type: 'multi_line_text_field',
          name: 'Again',
        }),
      ),
    ).toEqual([['key', 'TAKEN']]);
    // A value takes its definition's type, and refuses another.
    unwrap(
      await metafields.set(f.a, [
        {
          owner: { type: 'product', id: kurta.id },
          namespace: 'custom',
          key: 'care',
          value: 'Wash',
        },
      ]),
    );
    expect(
      errorsOf(
        await metafields.set(f.a, [
          {
            owner: { type: 'product', id: kurta.id },
            namespace: 'custom',
            key: 'care',
            type: 'json',
            value: '{}',
          },
        ]),
      ),
    ).toEqual([['metafields.0.type', 'INVALID']]);
    expect((await metafields.definitions(f.a, 'product'))[0]).toMatchObject({
      name: 'Care instructions',
      valuesCount: 1,
    });
    expect(await metafields.definitions(f.b)).toEqual([]);
    expect(unwrap(await metafields.updateDefinition(f.a, care.id, { name: 'Care' })).name).toBe(
      'Care',
    );
    // Deleted, with its values on every product.
    unwrap(await metafields.deleteDefinition(f.a, care.id, true));
    expect(await metafields.definitions(f.a)).toEqual([]);
    expect(
      (await metafields.ofOwners(f.a, 'product', [kurta.id])).get(kurta.id)!.map((m) => m.key),
    ).toEqual(['pieces']);
  });

  it(`keeps ${METAFIELD_LIMITS.perOwner} metafields on an owner, and sets ${METAFIELD_LIMITS.perCall} at once`, async () => {
    const kurta = await product('Lawn kurta');
    const many = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        owner: { type: 'product' as const, id: kurta.id },
        namespace: 'custom',
        key: `field_${from + index}`,
        type: 'single_line_text_field',
        value: 'x',
      }));
    expect(errorsOf(await metafields.set(f.a, many(0, 26)))).toEqual([['metafields', 'TOO_MANY']]);
    for (let from = 0; from < METAFIELD_LIMITS.perOwner; from += 25) {
      unwrap(await metafields.set(f.a, many(from, 25)));
    }
    expect(errorsOf(await metafields.set(f.a, many(500, 1)))).toEqual([
      ['metafields.0.ownerId', 'TOO_MANY'],
    ]);
    expect((await metafields.ofOwners(f.a, 'product', [kurta.id])).get(kurta.id)).toHaveLength(
      METAFIELD_LIMITS.perOwner,
    );
  });
});
