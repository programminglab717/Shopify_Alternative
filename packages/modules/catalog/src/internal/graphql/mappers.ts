import { Money, PageInfo, SEO, UserError, badUserInput, encodeCursor } from '@hatti/api';
import { toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import type { FieldError } from '../input-checker.js';
import { parseProductSearch } from '../product-filter.js';
import type { CollectionRecord, MediaRecord, ProductRecord, VariantRecord } from '../records.js';
import type { CollectionSortOrderValue, ProductStatusValue } from '../schema.js';
import {
  Collection,
  CollectionConnection,
  CollectionEdge,
  CollectionRule,
  CollectionRuleColumn,
  CollectionRuleRelation,
  CollectionRuleSet,
  CollectionSortOrder,
} from './collection.types.js';
import {
  MediaContentType,
  MediaError,
  MediaErrorCode,
  MediaStatus,
  Product,
  ProductConnection,
  ProductEdge,
  ProductMedia,
  ProductOption,
  ProductOptionValue,
  ProductPriceRange,
  ProductStatus,
  ProductVariant,
  SelectedOption,
} from './product.types.js';

/** The UUID behind a public ID of the given kind, or a BAD_USER_INPUT error. */
export function uuidOf(kind: IdKind, id: string): string {
  const uuid = tryFromPublicId(id, kind);
  if (!uuid) throw badUserInput(`Invalid ${kind} id: ${id.slice(0, 64)}`);
  return uuid;
}

/** Like {@link uuidOf}, for optional arguments: undefined and null pass through. */
export function optionalUuidOf<T extends null | undefined>(
  kind: IdKind,
  id: string | T,
): string | T {
  return id === null || id === undefined ? id : uuidOf(kind, id);
}

/** A products search the list takes (ADR-120), or a BAD_USER_INPUT error saying what is wrong. */
export function productSearch(query: string | null | undefined): string | null {
  if (!query) return null;
  const search = parseProductSearch(query);
  if (!search.ok) throw badUserInput(search.error);
  return query;
}

export function toStatusValue(status: ProductStatus): ProductStatusValue {
  return status.toLowerCase() as ProductStatusValue;
}

export function toSortOrderValue(order: CollectionSortOrder): CollectionSortOrderValue {
  return order.toLowerCase() as CollectionSortOrderValue;
}

function toMoney(amount: bigint | null, currency: CurrencyCode): Money | null {
  return amount === null ? null : Money.from(money(amount, currency));
}

const MEDIA_ERROR_CODES = new Set<string>(Object.values(MediaErrorCode));

/** A product's media; `handle`, its product's, names its image's address. */
export function toMedia(record: MediaRecord, handle: string): ProductMedia {
  return Object.assign(new ProductMedia(), {
    id: toPublicId('media', record.id),
    mediaContentType: MediaContentType.IMAGE,
    alt: record.alt,
    position: record.position,
    status: record.status.toUpperCase() as MediaStatus,
    sourceUrl: record.sourceUrl,
    width: record.width,
    height: record.height,
    mediaErrors: record.error
      ? [
          Object.assign(new MediaError(), {
            code: MEDIA_ERROR_CODES.has(record.error.code)
              ? (record.error.code as MediaErrorCode)
              : MediaErrorCode.UNKNOWN,
            message: record.error.message,
          }),
        ]
      : [],
    record,
    handle,
  });
}

export function toVariant(
  record: VariantRecord,
  currency: CurrencyCode,
  media: ReadonlyMap<string, ProductMedia>,
): ProductVariant {
  return Object.assign(new ProductVariant(), {
    id: toPublicId('variant', record.id),
    title: record.title,
    selectedOptions: record.selectedOptions.map((selected) =>
      Object.assign(new SelectedOption(), { name: selected.name, value: selected.value }),
    ),
    sku: record.sku,
    barcode: record.barcode,
    price: Money.from(money(record.price, currency)),
    compareAtPrice: toMoney(record.compareAtPrice, currency),
    cost: toMoney(record.cost, currency),
    weightGrams: record.weightGrams,
    taxable: record.taxable,
    taxCode: record.taxCode,
    position: record.position,
    media: record.mediaId === null ? null : (media.get(record.mediaId) ?? null),
  });
}

function priceRange(record: ProductRecord, currency: CurrencyCode): ProductPriceRange {
  const prices = record.variants.map((variant) => variant.price);
  const min = prices.reduce((a, b) => (b < a ? b : a), prices[0] ?? 0n);
  const max = prices.reduce((a, b) => (b > a ? b : a), prices[0] ?? 0n);
  return Object.assign(new ProductPriceRange(), {
    minVariantPrice: Money.from(money(min, currency)),
    maxVariantPrice: Money.from(money(max, currency)),
  });
}

export function toProduct(record: ProductRecord, currency: CurrencyCode): Product {
  const media = record.media.map((item) => toMedia(item, record.handle));
  const mediaById = new Map(record.media.map((item, index) => [item.id, media[index]!]));
  return Object.assign(new Product(), {
    id: toPublicId('product', record.id),
    title: record.title,
    handle: record.handle,
    status: record.status.toUpperCase() as ProductStatus,
    description: record.description,
    vendor: record.vendor,
    productType: record.productType,
    tags: record.tags,
    seo: Object.assign(new SEO(), record.seo),
    options: record.options.map((option) =>
      Object.assign(new ProductOption(), {
        id: toPublicId('productOption', option.id),
        name: option.name,
        position: option.position,
        optionValues: option.values.map((value) =>
          Object.assign(new ProductOptionValue(), {
            id: toPublicId('productOptionValue', value.id),
            name: value.name,
            hasVariants: value.hasVariants,
          }),
        ),
      }),
    ),
    variants: record.variants.map((variant) => toVariant(variant, currency, mediaById)),
    media,
    priceRange: priceRange(record, currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toProductConnection(
  products: Product[],
  cursors: string[],
  hasNextPage: boolean,
): ProductConnection {
  const edges = products.map((node, index) =>
    Object.assign(new ProductEdge(), { node, cursor: cursors[index]! }),
  );
  return Object.assign(new ProductConnection(), {
    edges,
    nodes: products,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

export function toCollection(record: CollectionRecord): Collection {
  return Object.assign(new Collection(), {
    id: toPublicId('collection', record.id),
    title: record.title,
    handle: record.handle,
    description: record.description,
    sortOrder: record.sortOrder.toUpperCase() as CollectionSortOrder,
    seo: Object.assign(new SEO(), record.seo),
    ruleSet:
      record.rules === null
        ? null
        : Object.assign(new CollectionRuleSet(), {
            appliedDisjunctively: record.disjunctive,
            rules: record.rules.map((rule) =>
              Object.assign(new CollectionRule(), {
                column: rule.column.toUpperCase() as CollectionRuleColumn,
                relation: rule.relation.toUpperCase() as CollectionRuleRelation,
                condition: rule.condition,
              }),
            ),
          }),
    productsCount: record.productsCount,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toCollectionConnection(
  records: CollectionRecord[],
  hasNextPage: boolean,
): CollectionConnection {
  const nodes = records.map(toCollection);
  const edges = nodes.map((node, index) =>
    Object.assign(new CollectionEdge(), { node, cursor: encodeCursor({ id: records[index]!.id }) }),
  );
  return Object.assign(new CollectionConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

export function toUserErrors(errors: FieldError[]): UserError[] {
  return errors.map((error) => UserError.of(error.field, error.code, error.message));
}
