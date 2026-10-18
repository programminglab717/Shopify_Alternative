import 'reflect-metadata';
import { MetafieldService } from '@hatti/catalog/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PreferencesService, shopPreferencesOf } from './preferences.service.js';
import {
  StorefrontFiltersService,
  shownStorefrontFiltersIn,
} from './storefront-filters.service.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('StorefrontFiltersService', () => {
  let f: OnlineStoreFixture;
  let filters: StorefrontFiltersService;

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
    filters = new StorefrontFiltersService(f.db);
    const metafields = new MetafieldService(f.db);
    for (const [ownerType, namespace, key, type, name] of [
      ['product', 'custom', 'material', 'single_line_text_field', 'Material'],
      ['product', 'custom', 'occasions', 'list.single_line_text_field', 'Occasions'],
      ['variant', 'custom', 'handmade', 'boolean', 'Handmade'],
      ['product', 'custom', 'weight', 'number_decimal', 'Weight'],
      ['collection', 'custom', 'season', 'single_line_text_field', 'Season'],
    ] as const) {
      unwrap(await metafields.createDefinition(f.a, { ownerType, namespace, key, type, name }));
    }
    for (const [title, options] of [
      ['Lawn suit', ['Size', 'Colour']],
      ['Kurta', ['Size']],
      ['Khaddar suit', ['size']],
      ['Khussa', ['Shoe size']],
    ] as const) {
      unwrap(
        await f.products.create(f.a, {
          title,
          options: options.map((name) => ({ name, values: ['One'] })),
          variants: [{ optionValues: options.map(() => 'One'), price: '1000' }],
        }),
      );
    }
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const DEFAULT = { label: null, labelUr: null, metafieldType: null };

  it("chooses none at first, and offers the platform's, the options and the metafields that filter", async () => {
    const view = await filters.get(f.a);
    expect(view.filters).toBeNull();
    expect(view.available.map((each) => [each.kind, each.key, each.defaultLabel])).toEqual([
      ['availability', null, 'Availability'],
      ['price', null, 'Price'],
      ['product_type', null, 'Product type'],
      ['vendor', null, 'Brand'],
      // Each option once whatever its case, the most used first, as most products spell it.
      ['option', 'Size', 'Size'],
      ['option', 'Colour', 'Colour'],
      ['option', 'Shoe size', 'Shoe size'],
      ['stitching', null, 'Stitching'],
      ['pieces', null, 'Pieces'],
      ['fabric', null, 'Fabric'],
      ['season', null, 'Season'],
      // Not numbers, nor a collection's.
      ['product_metafield', 'custom.material', 'Material'],
      ['product_metafield', 'custom.occasions', 'Occasions'],
      ['variant_metafield', 'custom.handmade', 'Handmade'],
    ]);
    expect(view.available.at(-1)!.metafieldType).toBe('boolean');
    // Another shop has none of the first's.
    expect((await filters.get(f.b)).available.map((each) => each.kind)).not.toContain('option');
  });

  it('keeps the filters chosen in their order and words, recording and auditing the change', async () => {
    const view = unwrap(
      await filters.update(f.a, [
        { kind: 'option', key: ' size ', label: 'Sizes', labelUr: 'سائز' },
        { kind: 'price' },
        { kind: 'variant_metafield', key: 'custom.handmade' },
        { kind: 'vendor', label: '  ', labelUr: 'برانڈ' },
        { kind: 'option', key: 'Fit' },
      ]),
    );
    expect(view.filters).toEqual([
      {
        ...DEFAULT,
        kind: 'option',
        key: 'size',
        label: 'Sizes',
        labelUr: 'سائز',
        defaultLabel: 'Size',
      },
      { kind: 'price', key: null, ...DEFAULT, defaultLabel: 'Price' },
      {
        kind: 'variant_metafield',
        key: 'custom.handmade',
        ...DEFAULT,
        defaultLabel: 'Handmade',
        metafieldType: 'boolean',
      },
      { kind: 'vendor', key: null, ...DEFAULT, labelUr: 'برانڈ', defaultLabel: 'Brand' },
      // An option none of its products has yet: allowed, called by its name.
      { kind: 'option', key: 'Fit', ...DEFAULT, defaultLabel: 'Fit' },
    ]);
    expect(await filters.get(f.a)).toEqual(view);
    // The same again changes nothing.
    unwrap(
      await filters.update(f.a, [
        { kind: 'option', key: 'size', label: 'Sizes', labelUr: 'سائز' },
        { kind: 'price' },
        { kind: 'variant_metafield', key: 'custom.handmade' },
        { kind: 'vendor', labelUr: 'برانڈ' },
        { kind: 'option', key: 'Fit' },
      ]),
    );
    const events = (await f.outbox()).filter(
      (event) => event.event_type === 'online_store_preferences.updated',
    );
    expect(events.map((event) => event.payload)).toEqual([{ changed: ['storefrontFilters'] }]);
    const { rows } = await f.admin.query<{ details: { filters: string[] } }>(
      `SELECT details FROM platform.audit_log
        WHERE shop_id = $1 AND action = 'storefront_filters.updated'`,
      [f.a.shopId],
    );
    expect(rows.at(-1)!.details.filters).toEqual([
      'option:size',
      'price',
      'variant_metafield:custom.handmade',
      'vendor',
      'option:Fit',
    ]);
    // None but the shop's own.
    expect((await filters.get(f.b)).filters).toBeNull();
  });

  it('leaves the other preferences as they are, and they leave the filters', async () => {
    const preferences = new PreferencesService(f.db, undefined as never, f.products);
    unwrap(await filters.update(f.a, [{ kind: 'availability' }]));
    unwrap(await preferences.update(f.a, { consentBanner: true }));
    const kept = await f.db.tenant(f.a.shopId, (tx) => shopPreferencesOf(tx, f.a.shopId));
    expect(kept.consentBanner).toBe(true);
    expect(kept.storefrontFilters).toEqual([
      { kind: 'availability', key: null, label: null, labelUr: null },
    ]);
  });

  it("goes back to the platform's with null, and shows none with an empty list", async () => {
    unwrap(await filters.update(f.a, []));
    expect((await filters.get(f.a)).filters).toEqual([]);
    unwrap(await filters.update(f.a, null));
    expect((await filters.get(f.a)).filters).toBeNull();
    const events = (await f.outbox()).filter(
      (event) => event.event_type === 'online_store_preferences.updated',
    );
    expect(events).toHaveLength(2);
  });

  it('refuses unknown kinds and definitions, keys where none belong, twice, and too many', async () => {
    expect(
      errorsOf(
        await filters.update(f.a, [
          { kind: 'colour' },
          { kind: 'option' },
          { kind: 'vendor', key: 'Zari' },
          { kind: 'price', label: 'x'.repeat(61) },
          { kind: 'availability' },
          { kind: 'availability' },
          { kind: 'option', key: 'Size' },
          { kind: 'option', key: 'SIZE' },
        ]),
      ),
    ).toEqual([
      ['input.filters.0.kind', 'INVALID', expect.stringContaining('Kind must be one of')],
      ['input.filters.1.key', 'BLANK', "Give the option's name, like Size"],
      ['input.filters.2.key', 'INVALID', 'Only an option or a metafield filter takes a key'],
      ['input.filters.3.label', 'TOO_LONG', 'Label is too long (maximum is 60 characters)'],
      ['input.filters.5.kind', 'TAKEN', 'This filter is chosen twice'],
      ['input.filters.7.key', 'TAKEN', 'This filter is chosen twice'],
    ]);
    expect(
      errorsOf(
        await filters.update(f.a, [
          { kind: 'product_metafield', key: 'custom.handmade' },
          { kind: 'variant_metafield', key: 'custom.handmade' },
          { kind: 'product_metafield', key: 'custom.weight' },
          { kind: 'product_metafield', key: 'custom' },
        ]),
      ),
    ).toEqual([
      [
        'input.filters.0.key',
        'NOT_FOUND',
        'No product metafield definition of the shop has this namespace and key',
      ],
      [
        'input.filters.2.key',
        'INVALID',
        'Only single line text, lists of it, and true or false metafields filter products',
      ],
      [
        'input.filters.3.key',
        'NOT_FOUND',
        'No product metafield definition of the shop has this namespace and key',
      ],
    ]);
    // Another shop's definitions are not its.
    expect(
      errorsOf(await filters.update(f.b, [{ kind: 'product_metafield', key: 'custom.material' }])),
    ).toEqual([
      [
        'input.filters.0.key',
        'NOT_FOUND',
        'No product metafield definition of the shop has this namespace and key',
      ],
    ]);
    const many = Array.from({ length: 26 }, (_, index) => ({ kind: 'option', key: `O${index}` }));
    expect(errorsOf(await filters.update(f.a, many))).toEqual([
      ['input.filters', 'TOO_LONG', 'A storefront shows 25 filters at most'],
    ]);
    expect((await filters.get(f.a)).filters).toBeNull();
    expect(await f.outbox()).toEqual([]);
  });

  it("gives the storefront a metafield's filter by its definition's name, unless it has its own", async () => {
    unwrap(
      await filters.update(f.a, [
        { kind: 'product_metafield', key: 'custom.material' },
        { kind: 'product_metafield', key: 'custom.occasions', label: 'Occasion' },
        { kind: 'option', key: 'Size' },
      ]),
    );
    const shown = await f.db.tenant(f.a.shopId, (tx) => shownStorefrontFiltersIn(tx, f.a.shopId));
    expect(shown).toEqual([
      { kind: 'product_metafield', key: 'custom.material', label: 'Material', labelUr: null },
      { kind: 'product_metafield', key: 'custom.occasions', label: 'Occasion', labelUr: null },
      // An option's is called as the page's products call it.
      { kind: 'option', key: 'Size', label: null, labelUr: null },
    ]);
    expect(
      await f.db.tenant(f.b.shopId, (tx) => shownStorefrontFiltersIn(tx, f.b.shopId)),
    ).toBeNull();
  });
});
