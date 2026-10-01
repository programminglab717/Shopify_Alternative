// The catalog's public surface. Everything under src/internal is private to this module.
export { CatalogModule } from '../internal/catalog.module.js';
export {
  RELATIONS_BY_COLUMN,
  RULE_COLUMNS,
  RULE_RELATIONS,
  type RuleColumn,
  type RuleRelation,
} from '../internal/collection-rules.js';
export {
  CollectionService,
  type CollectionRuleSetInput,
  type CreateCollectionInput,
  type UpdateCollectionInput,
} from '../internal/collection.service.js';
export {
  CatalogEvents,
  type CollectionCreatedPayload,
  type CollectionDeletedPayload,
  type CollectionUpdatedPayload,
  type ProductCreatedPayload,
  type ProductDeletedPayload,
  type ProductUpdatedPayload,
} from '../internal/events.js';
export { handleCandidate, toHandle } from '../internal/handle.js';
export type { FieldError, MutationResult } from '../internal/input-checker.js';
// GraphQL object types, so other modules can add fields to them, e.g. a variant's stock.
export { Product, ProductVariant } from '../internal/graphql/product.types.js';
export { MediaService, type MediaCreateInput } from '../internal/media.service.js';
export { OptionService, type OptionUpdateInput } from '../internal/option.service.js';
export { DEFAULT_VARIANT_TITLE } from '../internal/product-store.js';
export {
  ProductImportService,
  type ImportedStock,
  type ProductImportResult,
} from '../internal/product-import.service.js';
export {
  PRODUCT_EXPORT_LIMITS,
  ProductExportService,
  type ExportStock,
  type ProductExportResult,
} from '../internal/product-export.service.js';
export {
  PRODUCT_IMPORT_LIMITS,
  SHOPIFY_PRODUCT_HEADINGS,
  htmlToText,
  textToHtml,
  writeShopifyProducts,
  type ShopifyRowProblem,
  type ShopifyVariantStock,
} from '../internal/shopify-csv.js';
export {
  ProductService,
  activeProductsIn,
  type CreateProductInput,
  type ListProductsOptions,
  type UpdateProductInput,
} from '../internal/product.service.js';
export {
  PRODUCT_SEARCH_FILTERS,
  parseProductSearch,
  type ProductSearchKey,
} from '../internal/product-filter.js';
export type { ProductStatusValue } from '../internal/schema.js';
export type {
  CollectionRecord,
  MediaRecord,
  OptionRecord,
  ProductRecord,
  VariantRecord,
} from '../internal/records.js';
export type { OptionInput, VariantFieldsInput } from '../internal/variant-input.js';
export {
  VariantService,
  type VariantCreateInput,
  type VariantSnapshot,
  type VariantUpdateInput,
} from '../internal/variant.service.js';
