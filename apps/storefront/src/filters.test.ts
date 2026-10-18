import { describe, expect, it } from 'vitest';
import type { FilterDoc, ProductDoc } from '@hatti/storefront-data';
import {
  FILTERED_PRODUCTS_MAX,
  filteredListing,
  type QueryParams,
  type SortKind,
} from './filters.js';

/** A product with a variant for each size, `sold` those sold out, priced in rupees. */
function product(
  id: string,
  spec: {
    type?: string;
    vendor?: string;
    sizes?: string[];
    sold?: string[];
    rupees?: number;
    fabrics?: string[];
    pieces?: string;
  },
): ProductDoc {
  const sizes = spec.sizes ?? ['M'];
  return {
    id,
    handle: id,
    title: id,
    descriptionHtml: '',
    vendor: spec.vendor ?? 'Zari',
    productType: spec.type ?? 'Suit',
    tags: [],
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size, index) => ({
      id: `${id}-${size}`,
      title: size,
      sku: null,
      price: ((spec.rupees ?? 1000) + index * 100) * 100,
      compareAtPrice: null,
      available: !(spec.sold ?? []).includes(size),
      options: [size],
      image: null,
    })),
    images: [],
    ...(spec.fabrics || spec.pieces
      ? {
          easternWear: {
            fabrics: (spec.fabrics ?? []).map((fabric) => ({
              value: fabric,
              label: fabric[0]!.toUpperCase() + fabric.slice(1),
              ur: fabric,
            })),
            ...(spec.pieces
              ? { pieces: { value: spec.pieces, label: `${spec.pieces}-piece`, ur: spec.pieces } }
              : {}),
          },
        }
      : {}),
  };
}

const PRODUCTS = [
  product('lawn-a', {
    type: 'Suit',
    sizes: ['S', 'M', 'L'],
    sold: ['L'],
    rupees: 4000,
    fabrics: ['lawn'],
    pieces: '3',
  }),
  product('lawn-b', {
    type: 'Suit',
    sizes: ['S', 'M'],
    sold: ['S', 'M'],
    rupees: 6000,
    fabrics: ['lawn', 'chiffon'],
    pieces: '2',
  }),
  product('khaddar', {
    type: 'Suit',
    sizes: ['M', 'L'],
    rupees: 8000,
    fabrics: ['khaddar'],
    pieces: '3',
  }),
  product('khussa', { type: 'Footwear', vendor: 'Khussa Co', sizes: ['38', '39'], rupees: 2500 }),
];

async function listing(
  params: QueryParams,
  locale = 'en',
  products = PRODUCTS,
  kind: SortKind = 'collection',
  chosen?: FilterDoc[],
) {
  const byId = new Map(products.map((each) => [each.id, each]));
  let fetched = 0;
  const result = await filteredListing(
    products.map((each) => each.id),
    { params, path: '/collections/eid', locale },
    async (ids) => {
      fetched += ids.length;
      return ids.map((id) => byId.get(id) ?? null);
    },
    kind,
    chosen,
  );
  return { ...result, fetched };
}

type Filter = {
  label: string;
  param_name: string;
  type: string;
  values: {
    value: string;
    label: string;
    count: number;
    active: boolean;
    url_to_add: string;
    url_to_remove: string;
  }[];
  active_values: { value: string }[];
  url_to_remove: string;
  range_max?: number;
  min_value?: { value: number | null; param_name: string };
  max_value?: { value: number | null; param_name: string };
};

function filter(filters: Record<string, unknown>[], param: string): Filter {
  const found = filters.find((each) => each.param_name === param);
  if (!found) throw new Error(`no filter ${param}`);
  return found as unknown as Filter;
}

describe('Collection filters', () => {
  it('lists the filters a collection has, each value counted, in Shopify’s order', async () => {
    const { filters, productIds } = await listing([]);
    expect(productIds).toEqual(['lawn-a', 'lawn-b', 'khaddar', 'khussa']);
    expect(filters.map((each) => each.param_name)).toEqual([
      'filter.v.availability',
      'filter.v.price',
      'filter.p.product_type',
      'filter.p.vendor',
      'filter.v.option.size',
      'filter.p.m.hatti.pieces',
      'filter.p.m.hatti.fabric',
    ]);
    const availability = filter(filters, 'filter.v.availability');
    expect(availability.values.map((each) => [each.label, each.count])).toEqual([
      ['In stock', 3],
      ['Out of stock', 2],
    ]);
    // Sizes as the products sell them, first found first.
    expect(filter(filters, 'filter.v.option.size').values.map((each) => each.value)).toEqual([
      'S',
      'M',
      'L',
      '38',
      '39',
    ]);
    expect(filter(filters, 'filter.p.m.hatti.pieces').values.map((each) => each.label)).toEqual([
      '2-piece',
      '3-piece',
    ]);
    expect(
      filter(filters, 'filter.p.m.hatti.fabric').values.map((each) => [each.label, each.count]),
    ).toEqual([
      ['Chiffon', 1],
      ['Khaddar', 1],
      ['Lawn', 2],
    ]);
    const price = filter(filters, 'filter.v.price');
    expect(price.type).toBe('price_range');
    expect(price.range_max).toBe(810_000);
    expect(price.min_value).toMatchObject({ param_name: 'filter.v.price.gte', value: null });
    // Stitching and season: no product says them, so there is nothing to filter by.
    expect(filters.some((each) => each.param_name === 'filter.p.m.hatti.season')).toBe(false);
  });

  it('narrows the products: any of a filter’s values, all of the filters', async () => {
    const fabrics = await listing([
      ['filter.p.m.hatti.fabric', 'lawn'],
      ['filter.p.m.hatti.fabric', 'khaddar'],
    ]);
    expect(fabrics.productIds).toEqual(['lawn-a', 'lawn-b', 'khaddar']);
    const inStock = await listing([
      ['filter.p.m.hatti.fabric', 'lawn'],
      ['filter.p.m.hatti.fabric', 'khaddar'],
      ['filter.v.availability', '1'],
    ]);
    expect(inStock.productIds).toEqual(['lawn-a', 'khaddar']);
    // Each value counts what the other filters leave: lawn-b is sold out, so in stock it has none.
    const fabric = filter(inStock.filters, 'filter.p.m.hatti.fabric');
    expect(fabric.values.map((each) => [each.value, each.count, each.active])).toEqual([
      ['chiffon', 0, false],
      ['khaddar', 1, true],
      ['lawn', 1, true],
    ]);
    expect(fabric.active_values.map((each) => each.value)).toEqual(['khaddar', 'lawn']);
  });

  it('holds a variant’s filters of one variant together', async () => {
    // lawn-a has L, but its L is sold out: in stock in L, only khaddar.
    const { productIds, filters } = await listing([
      ['filter.v.option.size', 'L'],
      ['filter.v.availability', '1'],
    ]);
    expect(productIds).toEqual(['khaddar']);
    const sizes = filter(filters, 'filter.v.option.size');
    expect(sizes.values.find((each) => each.value === 'S')!.count).toBe(1);
    expect(sizes.values.find((each) => each.value === 'L')!.count).toBe(1);
  });

  it('filters by price in rupees, its variants’ prices in paisa', async () => {
    const { productIds, filters } = await listing([
      ['filter.v.price.gte', '3000'],
      ['filter.v.price.lte', '6,050'],
    ]);
    expect(productIds).toEqual(['lawn-a', 'lawn-b']);
    const price = filter(filters, 'filter.v.price');
    expect(price.min_value!.value).toBe(300_000);
    expect(price.max_value!.value).toBe(605_000);
    expect(price.url_to_remove).toBe('/collections/eid');
    // Not a price: as if not given.
    expect((await listing([['filter.v.price.gte', 'cheap']])).productIds).toHaveLength(4);
  });

  it('links to the page with a value added or taken away, the rest of the query kept', async () => {
    const { filters } = await listing([
      ['sort_by', 'price-ascending'],
      ['page', '3'],
      ['filter.p.product_type', 'Suit'],
      ['filter.p.unknown', 'x'],
    ]);
    const types = filter(filters, 'filter.p.product_type');
    const footwear = types.values.find((each) => each.value === 'Footwear')!;
    expect(footwear.url_to_add).toBe(
      '/collections/eid?sort_by=price-ascending&filter.p.product_type=Suit&filter.p.product_type=Footwear',
    );
    const suit = types.values.find((each) => each.value === 'Suit')!;
    expect(suit.active).toBe(true);
    expect(suit.url_to_remove).toBe('/collections/eid?sort_by=price-ascending');
    expect(types.url_to_remove).toBe('/collections/eid?sort_by=price-ascending');
  });

  it('names its filters in Urdu on Urdu pages', async () => {
    const { filters } = await listing([], 'ur');
    expect(filter(filters, 'filter.v.availability').label).toBe('دستیابی');
    expect(filter(filters, 'filter.v.availability').values[0]!.label).toBe('دستیاب');
    expect(filter(filters, 'filter.p.m.hatti.fabric').label).toBe('کپڑا');
  });

  it('leaves a filter out where all its products have the one value, unless it was chosen', async () => {
    const suits = PRODUCTS.slice(0, 3);
    expect((await listing([], 'en', suits)).filters.map((each) => each.param_name)).not.toContain(
      'filter.p.vendor',
    );
    const chosen = await listing([['filter.p.vendor', 'Zari']], 'en', suits);
    expect(filter(chosen.filters, 'filter.p.vendor').values).toHaveLength(1);
  });

  it('does not filter a collection of more products than it may fetch', async () => {
    const many = Array.from({ length: FILTERED_PRODUCTS_MAX + 1 }, (_, index) =>
      product(`p-${index}`, {}),
    );
    const result = await listing([['filter.v.availability', '0']], 'en', many);
    expect(result.filters).toEqual([]);
    expect(result.productIds).toHaveLength(FILTERED_PRODUCTS_MAX + 1);
    expect(result.fetched).toBe(0);
  });
});

/** The products, with metafields: of each product, and of each of its variants by size. */
function withMetafields(
  products: readonly ProductDoc[],
  fields: Record<
    string,
    { product?: Record<string, [string, string]>; variants?: Record<string, boolean> }
  >,
): ProductDoc[] {
  return products.map((product) => {
    const own = fields[product.id];
    if (!own) return product;
    return {
      ...product,
      ...(own.product && {
        metafields: {
          custom: Object.fromEntries(
            Object.entries(own.product).map(([key, [type, value]]) => [key, { type, value }]),
          ),
        },
      }),
      variants: product.variants.map((variant) => {
        const handmade = own.variants?.[variant.options[0]!];
        return handmade === undefined
          ? variant
          : {
              ...variant,
              metafields: { custom: { handmade: { type: 'boolean', value: String(handmade) } } },
            };
      }),
    };
  });
}

describe('The filters a shop chose (ADR-568)', () => {
  it('shows those chosen alone, in their order, under the shop’s words', async () => {
    const { filters } = await listing([], 'en', PRODUCTS, 'collection', [
      { kind: 'option', key: 'SIZE', label: 'Sizes' },
      { kind: 'fabric' },
      { kind: 'price', label: 'Budget' },
      { kind: 'product_type' },
      { kind: 'availability' },
      // None of the products has a fit, nor a season: nothing to show.
      { kind: 'option', key: 'Fit' },
      { kind: 'season' },
    ]);
    expect(filters.map((each) => [each.param_name, each.label])).toEqual([
      ['filter.v.option.size', 'Sizes'],
      ['filter.p.m.hatti.fabric', 'Fabric'],
      ['filter.v.price', 'Budget'],
      ['filter.p.product_type', 'Product type'],
      ['filter.v.availability', 'Availability'],
    ]);
    // An option's filter is called as the products call it, without words of the shop's own.
    const named = await listing([], 'en', PRODUCTS, 'collection', [
      { kind: 'option', key: 'size' },
    ]);
    expect(named.filters.map((each) => each.label)).toEqual(['Size']);
  });

  it('ignores the parameters of filters the shop hid', async () => {
    const hidden = await listing(
      [
        ['filter.p.product_type', 'Footwear'],
        ['filter.v.price.gte', '5000'],
        ['filter.v.availability', '1'],
      ],
      'en',
      PRODUCTS,
      'collection',
      [{ kind: 'availability' }, { kind: 'vendor' }],
    );
    // In stock alone: the type and the price are not asked for.
    expect(hidden.productIds).toEqual(['lawn-a', 'khaddar', 'khussa']);
    expect(hidden.filters.map((each) => each.param_name)).toEqual([
      'filter.v.availability',
      'filter.p.vendor',
    ]);
    // Its links leave them off.
    const vendor = filter(hidden.filters, 'filter.p.vendor');
    expect(vendor.values[0]!.url_to_add).toBe(
      '/collections/eid?filter.v.availability=1&filter.p.vendor=Khussa+Co',
    );
    // None chosen: nothing filters.
    const none = await listing([['filter.v.availability', '1']], 'en', PRODUCTS, 'collection', []);
    expect(none.filters).toEqual([]);
    expect(none.filtered).toBe(false);
    expect(none.productIds).toEqual(['lawn-a', 'lawn-b', 'khaddar', 'khussa']);
  });

  const METAFIELDS = withMetafields(PRODUCTS, {
    'lawn-a': {
      product: {
        material: ['single_line_text_field', 'Cotton'],
        occasions: ['list.single_line_text_field', '["Eid","Wedding"]'],
      },
      variants: { S: true, M: false },
    },
    'lawn-b': {
      product: {
        material: ['single_line_text_field', 'Silk'],
        occasions: ['list.single_line_text_field', '["Eid"]'],
      },
      variants: { S: true, M: true },
    },
    khaddar: {
      product: { material: ['single_line_text_field', 'Cotton'] },
      variants: { M: false, L: false },
    },
  });
  const METAFIELD_FILTERS: FilterDoc[] = [
    { kind: 'product_metafield', key: 'custom.material', label: 'Material' },
    { kind: 'product_metafield', key: 'custom.occasions', label: 'Occasion', labelUr: 'موقع' },
    { kind: 'variant_metafield', key: 'custom.handmade', label: 'Handmade' },
    { kind: 'availability' },
  ];

  it('filters by product metafields, each of a list’s words a value', async () => {
    const all = await listing([], 'en', METAFIELDS, 'collection', METAFIELD_FILTERS);
    expect(
      filter(all.filters, 'filter.p.m.custom.material').values.map((each) => [
        each.value,
        each.count,
      ]),
    ).toEqual([
      ['Cotton', 2],
      ['Silk', 1],
    ]);
    expect(
      filter(all.filters, 'filter.p.m.custom.occasions').values.map((each) => [
        each.value,
        each.count,
      ]),
    ).toEqual([
      ['Eid', 2],
      ['Wedding', 1],
    ]);
    const cotton = await listing(
      [['filter.p.m.custom.material', 'Cotton']],
      'en',
      METAFIELDS,
      'collection',
      METAFIELD_FILTERS,
    );
    expect(cotton.productIds).toEqual(['lawn-a', 'khaddar']);
    const eid = await listing(
      [
        ['filter.p.m.custom.material', 'Cotton'],
        ['filter.p.m.custom.occasions', 'Eid'],
      ],
      'en',
      METAFIELDS,
      'collection',
      METAFIELD_FILTERS,
    );
    expect(eid.productIds).toEqual(['lawn-a']);
    // Each occasion counts what the material leaves.
    expect(
      filter(eid.filters, 'filter.p.m.custom.occasions').values.map((each) => [
        each.value,
        each.count,
        each.active,
      ]),
    ).toEqual([
      ['Eid', 1, true],
      ['Wedding', 1, false],
    ]);
  });

  it('filters by variant metafields, true or false, of one variant with its other filters', async () => {
    const all = await listing([], 'en', METAFIELDS, 'collection', METAFIELD_FILTERS);
    const handmade = filter(all.filters, 'filter.v.m.custom.handmade');
    expect(handmade.values.map((each) => [each.value, each.label, each.count])).toEqual([
      ['true', 'Yes', 2],
      ['false', 'No', 2],
    ]);
    const made = await listing(
      [['filter.v.m.custom.handmade', 'true']],
      'en',
      METAFIELDS,
      'collection',
      METAFIELD_FILTERS,
    );
    expect(made.productIds).toEqual(['lawn-a', 'lawn-b']);
    // lawn-a's handmade S is in stock; lawn-b's handmade variants are all sold out.
    const inStock = await listing(
      [
        ['filter.v.m.custom.handmade', 'true'],
        ['filter.v.availability', '1'],
      ],
      'en',
      METAFIELDS,
      'collection',
      METAFIELD_FILTERS,
    );
    expect(inStock.productIds).toEqual(['lawn-a']);
  });

  it('names them in Urdu on Urdu pages: the shop’s Urdu words, else its own, else the platform’s', async () => {
    const { filters } = await listing([], 'ur', METAFIELDS, 'collection', [
      ...METAFIELD_FILTERS,
      { kind: 'product_type', label: 'Kind' },
      { kind: 'vendor', label: 'Maker', labelUr: 'بنانے والا' },
    ]);
    expect(filters.map((each) => each.label)).toEqual([
      'Material',
      'موقع',
      'Handmade',
      'دستیابی',
      'Kind',
      'بنانے والا',
    ]);
    expect(filter(filters, 'filter.v.m.custom.handmade').values.map((each) => each.label)).toEqual([
      'ہاں',
      'نہیں',
    ]);
  });

  it('finds an option by the shop’s own name on a page that shows it translated', async () => {
    const translated = PRODUCTS.map((product) => ({
      ...product,
      options: [{ name: 'سائز', values: product.options[0]!.values, ownName: 'Size' }],
    }));
    const { filters, productIds } = await listing(
      [['filter.v.option.size', 'L']],
      'ur',
      translated,
      'collection',
      [{ kind: 'option', key: 'Size' }],
    );
    expect(productIds).toEqual(['lawn-a', 'khaddar']);
    // Called as the page calls it.
    expect(filters.map((each) => [each.param_name, each.label])).toEqual([
      ['filter.v.option.size', 'سائز'],
    ]);
  });

  it('shows every filter in the platform’s order while the shop chose none', async () => {
    const none = await listing([['filter.p.vendor', 'Zari']]);
    const unset = await listing([['filter.p.vendor', 'Zari']], 'en', PRODUCTS, 'collection');
    expect(unset).toEqual(none);
    expect(none.filters.map((each) => each.param_name)).toEqual([
      'filter.v.availability',
      'filter.v.price',
      'filter.p.product_type',
      'filter.p.vendor',
      'filter.v.option.size',
      'filter.p.m.hatti.pieces',
      'filter.p.m.hatti.fabric',
    ]);
    // Metafields filter nothing until the shop chooses them.
    const params = (await listing([['filter.p.m.custom.material', 'Silk']], 'en', METAFIELDS))
      .productIds;
    expect(params).toHaveLength(4);
  });
});

describe('Sorting a list', () => {
  const dated = PRODUCTS.map((each, index) =>
    index === 3 ? each : { ...each, createdAt: `2026-0${index + 1}-01T00:00:00Z` },
  );

  it('puts a collection in the order asked for, its own unless one of Shopify’s', async () => {
    const order = async (sortBy: string, products = PRODUCTS) =>
      (await listing([['sort_by', sortBy]], 'en', products)).productIds;
    expect(await order('price-ascending')).toEqual(['khussa', 'lawn-a', 'lawn-b', 'khaddar']);
    expect(await order('price-descending')).toEqual(['khaddar', 'lawn-b', 'lawn-a', 'khussa']);
    expect(await order('title-ascending')).toEqual(['khaddar', 'khussa', 'lawn-a', 'lawn-b']);
    expect(await order('title-descending')).toEqual(['lawn-b', 'lawn-a', 'khussa', 'khaddar']);
    // Newest first; one without a date last.
    expect(await order('created-descending', dated)).toEqual([
      'khaddar',
      'lawn-b',
      'lawn-a',
      'khussa',
    ]);
    expect(await order('created-ascending', dated)).toEqual([
      'lawn-a',
      'lawn-b',
      'khaddar',
      'khussa',
    ]);
    expect(await order('best-selling')).toEqual(['lawn-a', 'lawn-b', 'khaddar', 'khussa']);
    const sorted = await listing([['sort_by', 'price-ascending']]);
    expect(sorted.sortBy).toBe('price-ascending');
    expect(sorted.sortOptions[0]).toEqual({ name: 'Featured', value: 'manual' });
    expect((await listing([['sort_by', 'nonsense']])).sortBy).toBe('manual');
  });

  it('sorts what the filters leave', async () => {
    const { productIds, filtered } = await listing([
      ['filter.p.product_type', 'Suit'],
      ['sort_by', 'price-descending'],
    ]);
    expect(filtered).toBe(true);
    expect(productIds).toEqual(['khaddar', 'lawn-b', 'lawn-a']);
  });

  it('gives a search its own orders, best first unless asked, in the page’s language', async () => {
    const found = await listing([], 'ur', PRODUCTS, 'search');
    expect(found.sortBy).toBe('relevance');
    expect(found.filtered).toBe(false);
    expect(found.sortOptions.map((each) => each.value)).toEqual([
      'relevance',
      'price-ascending',
      'price-descending',
    ]);
    expect(found.sortOptions[0]!.name).toBe('سب سے موزوں');
    // A collection's own orders are not a search's.
    const titled = await listing([['sort_by', 'title-ascending']], 'en', PRODUCTS, 'search');
    expect(titled.sortBy).toBe('relevance');
    expect(titled.productIds).toEqual(['lawn-a', 'lawn-b', 'khaddar', 'khussa']);
  });
});
