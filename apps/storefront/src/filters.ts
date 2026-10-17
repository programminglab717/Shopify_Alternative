import type { CollectionDoc, ProductDoc, VariantDoc } from '@hatti/storefront-data';

// Storefront filters (SRC-03, CAT-08, ADR-478): Shopify's `collection.filters` and its `filter.*`
// parameters on a collection's page. A shopper narrows the collection by availability, price,
// product type, vendor, each of its options, and its eastern-wear attributes; a filter's values
// each count the products the other filters leave that have it. Values within a filter are any
// of them, filters all of them, as on Shopify. A variant's filters hold of one variant together.

/** The most products a collection may have for its page to filter them, as fetched to count. */
export const FILTERED_PRODUCTS_MAX = 1000;

/** The query's parameters, each as often as it was given, as a filter's are. */
export type QueryParams = readonly (readonly [string, string])[];

/** What a page's filters are made from: its query, its address, and its language. */
export interface FilterRequest {
  params: QueryParams;
  /** The page's path as the shopper asked for it, with its language's prefix: links keep it. */
  path: string;
  locale: string;
}

export const PRICE_GTE = 'filter.v.price.gte';
export const PRICE_LTE = 'filter.v.price.lte';

/** Whether a query parameter is a filter's, which a page's links to itself carry as given. */
export function isFilterParam(name: string): boolean {
  return name.startsWith('filter.');
}

interface Word {
  value: string;
  label: string;
}

/** A list filter: what a product or each of its variants has of it. */
interface Dimension {
  param: string;
  label: string;
  /** A variant's filters hold of one of its variants, a product's of the product. */
  level: 'product' | 'variant';
  of(product: ProductDoc, variant: VariantDoc): readonly Word[];
  /** How its values are put in order: by label, as first found, or as given. */
  order: 'label' | 'found' | ((a: Word, b: Word) => number);
}

const LABELS = {
  en: {
    availability: 'Availability',
    in_stock: 'In stock',
    out_of_stock: 'Out of stock',
    price: 'Price',
    product_type: 'Product type',
    vendor: 'Brand',
    stitching: 'Stitching',
    pieces: 'Pieces',
    fabric: 'Fabric',
    season: 'Season',
  },
  ur: {
    availability: 'دستیابی',
    in_stock: 'دستیاب',
    out_of_stock: 'ختم ہو گیا',
    price: 'قیمت',
    product_type: 'قسم',
    vendor: 'برانڈ',
    stitching: 'سلائی',
    pieces: 'پیس',
    fabric: 'کپڑا',
    season: 'موسم',
  },
} as const;

/** The dimensions a collection's products have, in the order their filters are shown. */
function dimensionsOf(products: readonly ProductDoc[], locale: string): Dimension[] {
  const words = locale === 'ur' ? LABELS.ur : LABELS.en;
  const one = (value: string | null | undefined): Word[] =>
    value && value.trim() !== '' ? [{ value, label: value }] : [];
  const dimensions: Dimension[] = [
    {
      param: 'filter.v.availability',
      label: words.availability,
      level: 'variant',
      of: (_, variant) => [
        variant.available
          ? { value: '1', label: words.in_stock }
          : { value: '0', label: words.out_of_stock },
      ],
      order: (a, b) => b.value.localeCompare(a.value),
    },
    {
      param: 'filter.p.product_type',
      label: words.product_type,
      level: 'product',
      of: (product) => one(product.productType),
      order: 'label',
    },
    {
      param: 'filter.p.vendor',
      label: words.vendor,
      level: 'product',
      of: (product) => one(product.vendor),
      order: 'label',
    },
  ];
  // Each option by its name, as products name it: their sizes in the order they are sold in.
  const options = new Map<string, string>();
  for (const product of products) {
    for (const option of product.options) {
      const key = option.name.trim().toLowerCase();
      if (key !== '' && !options.has(key)) options.set(key, option.name.trim());
    }
  }
  for (const [key, name] of options) {
    dimensions.push({
      param: `filter.v.option.${key}`,
      label: name,
      level: 'variant',
      of: (product, variant) => {
        const at = product.options.findIndex((option) => option.name.trim().toLowerCase() === key);
        return at < 0 ? [] : one(variant.options[at]);
      },
      order: 'found',
    });
  }
  const wear = (word: { value: string; label: string } | undefined): Word[] =>
    word ? [{ value: word.value, label: word.label }] : [];
  dimensions.push(
    {
      param: 'filter.p.m.hatti.stitching',
      label: words.stitching,
      level: 'product',
      of: (product) => wear(product.easternWear?.stitching),
      order: 'label',
    },
    {
      param: 'filter.p.m.hatti.pieces',
      label: words.pieces,
      level: 'product',
      of: (product) => wear(product.easternWear?.pieces),
      order: (a, b) => Number(a.value) - Number(b.value),
    },
    {
      param: 'filter.p.m.hatti.fabric',
      label: words.fabric,
      level: 'product',
      of: (product) => (product.easternWear?.fabrics ?? []).map((word) => wear(word)[0]!),
      order: 'label',
    },
    {
      param: 'filter.p.m.hatti.season',
      label: words.season,
      level: 'product',
      of: (product) => wear(product.easternWear?.season),
      order: 'label',
    },
  );
  return dimensions;
}

/** A price in the query, in rupees, as paisa; null where it is not one. */
function paisaOf(text: string | undefined): number | null {
  if (text === undefined || text.trim() === '') return null;
  const rupees = Number(text.replace(/,/g, ''));
  return Number.isFinite(rupees) && rupees >= 0 ? Math.round(rupees * 100) : null;
}

/** What the query asks for: each list filter's values, and the price's bounds in paisa. */
interface Selection {
  lists: Map<string, Set<string>>;
  price: { gte: number | null; lte: number | null };
}

function selectionOf(params: QueryParams, dimensions: readonly Dimension[]): Selection {
  const known = new Set(dimensions.map((dimension) => dimension.param));
  const lists = new Map<string, Set<string>>();
  let gte: number | null = null;
  let lte: number | null = null;
  for (const [name, value] of params) {
    if (name === PRICE_GTE) gte = paisaOf(value);
    else if (name === PRICE_LTE) lte = paisaOf(value);
    else if (known.has(name) && value !== '') {
      const values = lists.get(name) ?? new Set<string>();
      values.add(value);
      lists.set(name, values);
    }
  }
  return { lists, price: { gte, lte } };
}

const PRICE = 'price';

/**
 * Whether a product is among those the selection leaves, but for one filter's (`except`): its
 * own filters, and one of its variants all of the variants' filters.
 */
function leaves(
  product: ProductDoc,
  dimensions: readonly Dimension[],
  selection: Selection,
  except: string | null,
): boolean {
  const firstVariant = product.variants[0];
  for (const dimension of dimensions) {
    if (dimension.level !== 'product' || dimension.param === except) continue;
    const wanted = selection.lists.get(dimension.param);
    if (!wanted || !firstVariant) continue;
    if (!dimension.of(product, firstVariant).some((word) => wanted.has(word.value))) return false;
  }
  return product.variants.some((variant) =>
    variantLeft(product, variant, dimensions, selection, except),
  );
}

function variantLeft(
  product: ProductDoc,
  variant: VariantDoc,
  dimensions: readonly Dimension[],
  selection: Selection,
  except: string | null,
): boolean {
  for (const dimension of dimensions) {
    if (dimension.level !== 'variant' || dimension.param === except) continue;
    const wanted = selection.lists.get(dimension.param);
    if (wanted && !dimension.of(product, variant).some((word) => wanted.has(word.value))) {
      return false;
    }
  }
  if (except === PRICE) return true;
  const { gte, lte } = selection.price;
  return (gte === null || variant.price >= gte) && (lte === null || variant.price <= lte);
}

/** A collection as its page shows it: the products the filters leave, and the filters. */
export interface FilteredListing {
  productIds: readonly string[];
  filters: Record<string, unknown>[];
}

/** A link to the page with these filters, the query's other parameters but its page kept. */
function linkWith(request: FilterRequest, filters: QueryParams): string {
  const params = new URLSearchParams();
  for (const [name, value] of request.params) {
    if (name !== 'page' && !isFilterParam(name)) params.append(name, value);
  }
  for (const [name, value] of filters) params.append(name, value);
  const query = params.toString();
  return query === '' ? request.path : `${request.path}?${query}`;
}

/**
 * A collection as its page shows it, its products narrowed by the query's filters and its filters
 * counted. Unfiltered where it has more than {@link FILTERED_PRODUCTS_MAX} products.
 */
export async function filteredListing(
  doc: CollectionDoc,
  request: FilterRequest,
  products: (ids: readonly string[]) => Promise<(ProductDoc | null)[]>,
): Promise<FilteredListing> {
  if (doc.productIds.length === 0 || doc.productIds.length > FILTERED_PRODUCTS_MAX) {
    return { productIds: doc.productIds, filters: [] };
  }
  const docs = (await products(doc.productIds)).filter((each): each is ProductDoc => !!each);
  const dimensions = dimensionsOf(docs, request.locale);
  const selection = selectionOf(request.params, dimensions);
  const active =
    selection.lists.size > 0 || selection.price.gte !== null || selection.price.lte !== null;

  // The filters as asked for, in the order the page gives them: a link adds to them or takes away.
  const asked: [string, string][] = [];
  for (const dimension of dimensions) {
    for (const value of selection.lists.get(dimension.param) ?? [])
      asked.push([dimension.param, value]);
  }
  const priceAsked: [string, string][] = [];
  if (selection.price.gte !== null) priceAsked.push([PRICE_GTE, String(selection.price.gte / 100)]);
  if (selection.price.lte !== null) priceAsked.push([PRICE_LTE, String(selection.price.lte / 100)]);
  const all = [...asked, ...priceAsked];
  const without = (param: string, value?: string) =>
    all.filter(([name, each]) => !(name === param && (value === undefined || each === value)));

  const filters: Record<string, unknown>[] = [];
  for (const dimension of dimensions) {
    const wanted = selection.lists.get(dimension.param) ?? new Set<string>();
    const found = new Map<string, Word>();
    const counts = new Map<string, number>();
    for (const product of docs) {
      const firstVariant = product.variants[0];
      if (!firstVariant) continue;
      // Every value it has counts toward the filter's list; those the other filters leave count.
      const has = new Map<string, Word>();
      if (dimension.level === 'product') {
        for (const word of dimension.of(product, firstVariant)) has.set(word.value, word);
      } else {
        for (const variant of product.variants) {
          for (const word of dimension.of(product, variant)) has.set(word.value, word);
        }
      }
      for (const [value, word] of has) if (!found.has(value)) found.set(value, word);
      if (!leaves(product, dimensions, selection, dimension.param)) continue;
      const counted = new Set<string>();
      if (dimension.level === 'product') {
        for (const value of has.keys()) counted.add(value);
      } else {
        for (const variant of product.variants) {
          if (!variantLeft(product, variant, dimensions, selection, dimension.param)) continue;
          for (const word of dimension.of(product, variant)) counted.add(word.value);
        }
      }
      for (const value of counted) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    // A filter of one value narrows nothing, unless the shopper chose it.
    if (found.size < 2 && wanted.size === 0) continue;
    let words = [...found.values()];
    if (dimension.order === 'label') words.sort((a, b) => a.label.localeCompare(b.label));
    else if (typeof dimension.order === 'function') words = words.sort(dimension.order);
    const values = words.map((word) => {
      const isActive = wanted.has(word.value);
      return {
        value: word.value,
        label: word.label,
        count: counts.get(word.value) ?? 0,
        active: isActive,
        param_name: dimension.param,
        url_to_add: linkWith(request, [...all, [dimension.param, word.value]]),
        url_to_remove: linkWith(request, without(dimension.param, word.value)),
      };
    });
    filters.push({
      label: dimension.label,
      param_name: dimension.param,
      type: 'list',
      presentation: 'text',
      operator: 'OR',
      values,
      active_values: values.filter((value) => value.active),
      inactive_values: values.filter((value) => !value.active),
      url_to_remove: linkWith(request, without(dimension.param)),
    });
  }

  // The price's range, from the products the other filters leave: in paisa, as money prints it.
  const prices = docs.flatMap((product) => product.variants.map((variant) => variant.price));
  const rangeMax = prices.length > 0 ? Math.max(...prices) : 0;
  const rangeMin = prices.length > 0 ? Math.min(...prices) : 0;
  if (rangeMax > rangeMin || priceAsked.length > 0) {
    const bound = (param: string, value: number | null) => ({
      param_name: param,
      value,
      url_to_remove: linkWith(request, without(param)),
    });
    const words = request.locale === 'ur' ? LABELS.ur : LABELS.en;
    // After availability, before the rest, as Shopify's are by default.
    const at = filters.findIndex((filter) => filter.param_name !== 'filter.v.availability');
    filters.splice(at < 0 ? filters.length : at, 0, {
      label: words.price,
      param_name: 'filter.v.price',
      type: 'price_range',
      presentation: null,
      range_max: rangeMax,
      min_value: bound(PRICE_GTE, selection.price.gte),
      max_value: bound(PRICE_LTE, selection.price.lte),
      values: [],
      active_values: [],
      inactive_values: [],
      url_to_remove: linkWith(
        request,
        all.filter(([name]) => name !== PRICE_GTE && name !== PRICE_LTE),
      ),
    });
  }

  const productIds = active
    ? docs
        .filter((product) => leaves(product, dimensions, selection, null))
        .map((product) => product.id)
    : doc.productIds;
  return { productIds, filters };
}
