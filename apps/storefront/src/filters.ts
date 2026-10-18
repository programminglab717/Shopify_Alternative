import type { FilterDoc, ProductDoc, VariantDoc } from '@hatti/storefront-data';

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
  /** Before those of a greater rank, whatever their label: true before false. */
  rank?: number;
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
    yes: 'Yes',
    no: 'No',
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
    yes: 'ہاں',
    no: 'نہیں',
  },
} as const;

/** What a page's filters are, in the order they are shown: its list filters, and its price's. */
interface Shown {
  dimensions: Dimension[];
  /** Where the price's filter is among the list filters, before the one at `at`; null for none. */
  price: { at: number; label: string } | null;
}

type Words = (typeof LABELS)[keyof typeof LABELS];

const one = (value: string | null | undefined): Word[] =>
  value && value.trim() !== '' ? [{ value, label: value }] : [];

const wear = (word: { value: string; label: string } | undefined): Word[] =>
  word ? [{ value: word.value, label: word.label }] : [];

/** The platform's list filters, by the kind a shop chooses them by (ADR-568). */
function builtIns(words: Words) {
  return {
    availability: {
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
    product_type: {
      param: 'filter.p.product_type',
      label: words.product_type,
      level: 'product',
      of: (product) => one(product.productType),
      order: 'label',
    },
    vendor: {
      param: 'filter.p.vendor',
      label: words.vendor,
      level: 'product',
      of: (product) => one(product.vendor),
      order: 'label',
    },
    stitching: {
      param: 'filter.p.m.hatti.stitching',
      label: words.stitching,
      level: 'product',
      of: (product) => wear(product.easternWear?.stitching),
      order: 'label',
    },
    pieces: {
      param: 'filter.p.m.hatti.pieces',
      label: words.pieces,
      level: 'product',
      of: (product) => wear(product.easternWear?.pieces),
      order: (a, b) => Number(a.value) - Number(b.value),
    },
    fabric: {
      param: 'filter.p.m.hatti.fabric',
      label: words.fabric,
      level: 'product',
      of: (product) => (product.easternWear?.fabrics ?? []).map((word) => wear(word)[0]!),
      order: 'label',
    },
    season: {
      param: 'filter.p.m.hatti.season',
      label: words.season,
      level: 'product',
      of: (product) => wear(product.easternWear?.season),
      order: 'label',
    },
  } satisfies Record<string, Dimension>;
}

const folded = (name: string) => name.trim().toLowerCase();

/**
 * An option's filter, by its name folded: its values as the products sell them. `named` gives
 * the name an option is found by: as the page shows it, or as the shop named it.
 */
function optionDimension(
  key: string,
  label: string,
  named: (option: ProductDoc['options'][number]) => string,
): Dimension {
  return {
    param: `filter.v.option.${key}`,
    label,
    level: 'variant',
    of: (product, variant) => {
      const at = product.options.findIndex((option) => folded(named(option)) === key);
      return at < 0 ? [] : one(variant.options[at]);
    },
    order: 'found',
  };
}

/**
 * A metafield's filter (ADR-568), as Shopify names it: filter.p.m.custom.material of a
 * product's, filter.v.m.custom.material of a variant's. Its values are its words, each of a
 * list's, or true and false, which read as yes and no.
 */
function metafieldDimension(
  level: 'product' | 'variant',
  namespace: string,
  key: string,
  label: string,
  words: Words,
): Dimension {
  return {
    param: `filter.${level === 'product' ? 'p' : 'v'}.m.${namespace}.${key}`,
    label,
    level,
    of: (product, variant) => {
      const field = (level === 'product' ? product : variant).metafields?.[namespace]?.[key];
      if (!field) return [];
      if (field.type === 'single_line_text_field') return one(field.value);
      if (field.type === 'boolean') {
        if (field.value === 'true') return [{ value: 'true', label: words.yes, rank: 0 }];
        return field.value === 'false' ? [{ value: 'false', label: words.no, rank: 1 }] : [];
      }
      if (field.type !== 'list.single_line_text_field') return [];
      try {
        const list: unknown = JSON.parse(field.value);
        return Array.isArray(list)
          ? [...new Set(list.filter((each): each is string => typeof each === 'string'))].flatMap(
              one,
            )
          : [];
      } catch {
        return [];
      }
    },
    order: (a, b) => (a.rank ?? 2) - (b.rank ?? 2) || a.label.localeCompare(b.label),
  };
}

/**
 * The filters a page's products have, in the order they are shown: those the shop chose, in its
 * order and under its words (ADR-568), the page's Urdu ones on Urdu pages; or, while it chose
 * none, every one, as Shopify's are by default.
 */
function dimensionsOf(
  products: readonly ProductDoc[],
  locale: string,
  chosen: readonly FilterDoc[] | undefined,
): Shown {
  const words = locale === 'ur' ? LABELS.ur : LABELS.en;
  const builtIn = builtIns(words);
  if (!chosen) {
    // Each option by its name, as products name it: their sizes in the order they are sold in.
    const options = new Map<string, string>();
    for (const product of products) {
      for (const option of product.options) {
        const key = folded(option.name);
        if (key !== '' && !options.has(key)) options.set(key, option.name.trim());
      }
    }
    return {
      dimensions: [
        builtIn.availability,
        builtIn.product_type,
        builtIn.vendor,
        ...[...options].map(([key, name]) => optionDimension(key, name, (option) => option.name)),
        builtIn.stitching,
        builtIn.pieces,
        builtIn.fabric,
        builtIn.season,
      ],
      price: { at: 1, label: words.price },
    };
  }
  const dimensions: Dimension[] = [];
  let price: Shown['price'] = null;
  // Each once, as the online store chose them.
  const push = (dimension: Dimension) => {
    if (!dimensions.some((each) => each.param === dimension.param)) dimensions.push(dimension);
  };
  for (const filter of chosen) {
    // The shop's Urdu words on Urdu pages, else its own, else the platform's.
    const label = (fallback: string) =>
      (locale === 'ur' ? filter.labelUr : undefined) || filter.label || fallback;
    if (filter.kind === 'price') {
      price ??= { at: dimensions.length, label: label(words.price) };
    } else if (filter.kind === 'option') {
      const key = folded(filter.key ?? '');
      if (key === '') continue;
      // Found by its own name on a page that shows it translated, and called as the page does.
      const own = (option: ProductDoc['options'][number]) => option.ownName ?? option.name;
      const shown = products
        .flatMap((product) => product.options)
        .find((option) => folded(own(option)) === key);
      push(optionDimension(key, label(shown?.name.trim() ?? filter.key!.trim()), own));
    } else if (filter.kind === 'product_metafield' || filter.kind === 'variant_metafield') {
      const at = filter.key?.indexOf('.') ?? -1;
      if (at <= 0) continue;
      const [namespace, key] = [filter.key!.slice(0, at), filter.key!.slice(at + 1)];
      const level = filter.kind === 'product_metafield' ? 'product' : 'variant';
      push(metafieldDimension(level, namespace, key, label(filter.key!), words));
    } else {
      // A kind this storefront does not know yet shows nothing.
      const dimension = builtIn[filter.kind] as Dimension | undefined;
      if (dimension) push({ ...dimension, label: label(dimension.label) });
    }
  }
  return { dimensions, price };
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

/** What the query asks of the filters shown: those of filters the shop hid are not asked. */
function selectionOf(params: QueryParams, shown: Shown): Selection {
  const known = new Set(shown.dimensions.map((dimension) => dimension.param));
  const lists = new Map<string, Set<string>>();
  let gte: number | null = null;
  let lte: number | null = null;
  for (const [name, value] of params) {
    if (name === PRICE_GTE && shown.price) gte = paisaOf(value);
    else if (name === PRICE_LTE && shown.price) lte = paisaOf(value);
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
  /** Whether the page asked for any of the filters. */
  filtered: boolean;
  /** The order they are in, as Shopify's `sort_by`, and the orders a page may ask for. */
  sortBy: string;
  sortOptions: { name: string; value: string }[];
}

/** What a list's products may be put in order by: a collection's or a search's. */
export type SortKind = 'collection' | 'search';

/** Shopify's orders, as `sort_by` names them; a list's own first, its default. */
const SORTS: Record<SortKind, readonly string[]> = {
  collection: [
    'manual',
    'title-ascending',
    'title-descending',
    'price-ascending',
    'price-descending',
    'created-descending',
    'created-ascending',
  ],
  search: ['relevance', 'price-ascending', 'price-descending'],
};

const SORT_NAMES: Record<'en' | 'ur', Record<string, string>> = {
  en: {
    manual: 'Featured',
    relevance: 'Relevance',
    'title-ascending': 'Alphabetically, A-Z',
    'title-descending': 'Alphabetically, Z-A',
    'price-ascending': 'Price, low to high',
    'price-descending': 'Price, high to low',
    'created-descending': 'Date, new to old',
    'created-ascending': 'Date, old to new',
  },
  ur: {
    manual: 'نمایاں',
    relevance: 'سب سے موزوں',
    'title-ascending': 'حروفِ تہجی سے، A-Z',
    'title-descending': 'حروفِ تہجی سے، Z-A',
    'price-ascending': 'قیمت، کم سے زیادہ',
    'price-descending': 'قیمت، زیادہ سے کم',
    'created-descending': 'تاریخ، نئے پہلے',
    'created-ascending': 'تاریخ، پرانے پہلے',
  },
};

/** The order a page asks for, of those its list may be put in; its own where none or another. */
function sortOf(params: QueryParams, kind: SortKind): string {
  const asked = params.findLast(([name]) => name === 'sort_by')?.[1];
  return asked && SORTS[kind].includes(asked) ? asked : SORTS[kind][0]!;
}

function lowestPrice(product: ProductDoc): number {
  return Math.min(...product.variants.map((variant) => variant.price));
}

/** Products put in an order, those that tie as they were. Without a date, last. */
function sorted(products: readonly ProductDoc[], sortBy: string): ProductDoc[] {
  const [field, way] = sortBy.split('-') as [string, string | undefined];
  const sign = way === 'descending' ? -1 : 1;
  const list = [...products];
  if (field === 'title') {
    list.sort((a, b) => sign * a.title.localeCompare(b.title));
  } else if (field === 'price') {
    list.sort((a, b) => sign * (lowestPrice(a) - lowestPrice(b)));
  } else if (field === 'created') {
    list.sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return (a.createdAt ? 0 : 1) - (b.createdAt ? 0 : 1);
      return sign * a.createdAt.localeCompare(b.createdAt);
    });
  }
  return list;
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
  ids: readonly string[],
  request: FilterRequest,
  products: (ids: readonly string[]) => Promise<(ProductDoc | null)[]>,
  kind: SortKind = 'collection',
  /** The filters the shop chose, as its document has them (ADR-568); absent for every one. */
  chosen?: readonly FilterDoc[],
): Promise<FilteredListing> {
  const sortNames = request.locale === 'ur' ? SORT_NAMES.ur : SORT_NAMES.en;
  if (ids.length === 0 || ids.length > FILTERED_PRODUCTS_MAX) {
    return {
      productIds: ids,
      filters: [],
      filtered: false,
      sortBy: SORTS[kind][0]!,
      sortOptions: [],
    };
  }
  const sortBy = sortOf(request.params, kind);
  const sortOptions = SORTS[kind].map((value) => ({ name: sortNames[value]!, value }));
  const docs = (await products(ids)).filter((each): each is ProductDoc => !!each);
  const shown = dimensionsOf(docs, request.locale, chosen);
  const { dimensions } = shown;
  const selection = selectionOf(request.params, shown);
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
  // Where each filter's dimension is among those shown, for the price's to go among them.
  const places: number[] = [];
  for (const [place, dimension] of dimensions.entries()) {
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
    places.push(place);
  }

  // The price's range, from the products the other filters leave: in paisa, as money prints it.
  const prices = docs.flatMap((product) => product.variants.map((variant) => variant.price));
  const rangeMax = prices.length > 0 ? Math.max(...prices) : 0;
  const rangeMin = prices.length > 0 ? Math.min(...prices) : 0;
  if (shown.price && (rangeMax > rangeMin || priceAsked.length > 0)) {
    const bound = (param: string, value: number | null) => ({
      param_name: param,
      value,
      url_to_remove: linkWith(request, without(param)),
    });
    // Where the shop put it; after availability, before the rest, as Shopify's are by default.
    const before = shown.price.at;
    const at = places.findIndex((place) => place >= before);
    filters.splice(at < 0 ? filters.length : at, 0, {
      label: shown.price.label,
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

  const left = active
    ? docs.filter((product) => leaves(product, dimensions, selection, null))
    : null;
  const productIds =
    sortBy === SORTS[kind][0]
      ? (left?.map((product) => product.id) ?? ids)
      : sorted(left ?? docs, sortBy).map((product) => product.id);
  return { productIds, filters, filtered: active, sortBy, sortOptions };
}
