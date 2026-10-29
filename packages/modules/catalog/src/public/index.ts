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
  collectionImageOf,
  collectionsPicturingIn,
  type CollectionImageInput,
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
export {
  IMAGES_PATH,
  cleanImageKey,
  cropNameOf,
  imagePathOf,
  imagesPrefixOf,
  parseImagePath,
  shownImagesPrefixOf,
  shownSizeOf,
} from '../internal/images.js';
export {
  MediaProcessing,
  type ClaimedMedia,
  type ClaimedVideo,
  type CopiedMedia,
  type ProcessedImage,
  type ReadyOutcome,
} from '../internal/media-processing.js';
export {
  CROP_MIN_SIDE,
  MediaService,
  type MediaContentTypeValue,
  type MediaCreateInput,
  type MediaUpdateInput,
} from '../internal/media.service.js';
export {
  VIDEOS_PATH,
  externalVideoUrls,
  hostPreviewsOf,
  parseVideoPath,
  videoKeyOf,
  videoPathOf,
  vimeoOembedUrl,
  type VideoHostValue,
} from '../internal/videos.js';
export { OptionService, type OptionUpdateInput } from '../internal/option.service.js';
export { DEFAULT_VARIANT_TITLE } from '../internal/product-store.js';
export { CopiedVariantStock, type VariantCopy } from '../internal/product-copy.js';
export {
  ProductImportService,
  type ImportedStock,
  type ProductImportFormat,
  type ProductImportResult,
} from '../internal/product-import.service.js';
export {
  PRODUCT_EXPORT_LIMITS,
  ProductExportService,
  type ExportStock,
  type ProductExportResult,
} from '../internal/product-export.service.js';
export {
  SHOPIFY_INVENTORY_HEADINGS,
  readShopifyInventory,
  writeShopifyInventory,
  type ShopifyCount,
  type StockLevel,
} from '../internal/shopify-inventory-csv.js';
export {
  STOCK_FILE_LIMITS,
  StockFileService,
  type StockCount,
  type StockFile,
  type StockLevels,
} from '../internal/stock-file.service.js';
export {
  PRODUCT_IMPORT_LIMITS,
  SHOPIFY_PRODUCT_HEADINGS,
  htmlToText,
  rescaledShopifyPrices,
  textToHtml,
  writeShopifyProducts,
  type ShopifyRowProblem,
  type ShopifyVariantStock,
} from '../internal/shopify-csv.js';
export {
  ProductService,
  activeProductsIn,
  optionNamesIn,
  type CreateProductInput,
  type DuplicateProductInput,
  type ListProductsOptions,
  type UpdateProductInput,
} from '../internal/product.service.js';
export {
  PRODUCT_SEARCH_FILTERS,
  parseProductSearch,
  type ProductSearchKey,
} from '../internal/product-filter.js';
export type { ImageFormatValue, MediaTypeValue, ProductStatusValue } from '../internal/schema.js';
export type {
  CollectionImageValue,
  CollectionRecord,
  FocalPointRecord,
  MediaCropRecord,
  MediaErrorRecord,
  MediaRecord,
  VideoRecord,
  VideoSizeRecord,
  OptionRecord,
  ProductRecord,
  VariantRecord,
} from '../internal/records.js';
export type { OptionInput, VariantFieldsInput } from '../internal/variant-input.js';
export {
  VariantService,
  type VariantCreateInput,
  type VariantForSale,
  type VariantSnapshot,
  type VariantUpdateInput,
} from '../internal/variant.service.js';
export {
  PUBLISH_FROM,
  ProductReviewService,
  type ProductReviewRecord,
  type ReviewQuery,
} from '../internal/review.service.js';
export {
  REVIEW_LIMITS,
  ReviewEvents,
  eraseReviewsIn,
  mergeReviewsIn,
  ordersReviewedIn,
  publishFromIn,
  reviewAuthorName,
  reviewSettingsIn,
  reviewableProductsIn,
  reviewsOfCustomerIn,
  reviewsOfOrderIn,
  shopsRequestingReviewsIn,
  shownReviewsIn,
  writeReviewsIn,
  type OrderReview,
  type ProductReviewChangedPayload,
  type ReviewInput,
  type ReviewSettingsRecord,
  type ReviewStatusValue,
  type ShownReviews,
} from '../internal/reviews.js';
export {
  METAFIELD_LIMITS,
  METAFIELD_TYPES,
  MetafieldEvents,
  MetafieldService,
  RESERVED_NAMESPACES,
  isMetafieldType,
  metafieldDefinitionsIn,
  shownMetafieldsIn,
  type MetafieldDefinitionRecord,
  type MetafieldSetInput,
  type MetafieldsChangedPayload,
  type MetafieldOwnerType,
  type MetafieldRecord,
  type ShownMetafield,
  type ShownMetafields,
} from '../internal/metafields.js';
export {
  SEARCH_SYNONYM_LIMITS,
  SearchSynonymEvents,
  type SearchSynonymGroup,
  type SearchSynonymsUpdatedPayload,
} from '../internal/search-synonyms.js';
export {
  SEARCH_RULE_LIMITS,
  SearchRuleEvents,
  type SearchRuleUpdatedPayload,
} from '../internal/search-rules.js';
export {
  SIZE_CHART_LIMITS,
  SizeChartEvents,
  SizeChartService,
  shownSizeChartsIn,
  type ShownSizeChart,
  type SizeChartChangedPayload,
  type SizeChartInput,
  type SizeChartRecord,
  type SizeChartRow,
  type SizeChartUnitValue,
} from '../internal/size-charts.js';
export {
  BUNDLE_LIMITS,
  BundleEvents,
  BundleService,
  bundleProductIdsIn,
  bundleSellable,
  bundlesContainingIn,
  bundlesOfProductsIn,
  bundlesOfVariantsIn,
  type BundleComponent,
  type BundleComponentInput,
  type BundleRecord,
  type ProductBundleUpdatedPayload,
} from '../internal/bundles.js';
export { RELATED_PRODUCTS, relatedProductsIn } from '../internal/related-products.js';
// The products a customer's message may ask of, for the AI answering them (ADR-911).
export {
  ASKED_PRODUCTS,
  askedProductsIn,
  askedWordsOf,
  type AskedProduct,
} from '../internal/asked-products.js';
export { giftCardProductIdsIn } from '../internal/gift-card-products.js';
export {
  collectionsOfProductsIn,
  productsAndCollectionsIn,
  variantNamesIn,
  variantsIn,
  type VariantName,
} from '../internal/discount-scopes.js';
export {
  COMPLEMENTARY_PRODUCTS,
  ComplementEvents,
  ComplementService,
  complementsIn,
} from '../internal/complements.js';
export {
  DROP_LIMITS,
  DropEvents,
  DropService,
  dropFactsIn,
  dropStatus,
  waitingRoomsIn,
  type DropFact,
  type DropRecord,
  type DropUpdatedPayload,
} from '../internal/drops.js';
export {
  COMBINED_LISTING_LIMITS,
  CombinedListingEvents,
  CombinedListingService,
  combinedListingsIn,
  type CombinedListingMember,
  type CombinedListingRecord,
  type CombinedListingUpdatedPayload,
} from '../internal/combined-listings.js';
export {
  PERSONALISATION_KINDS,
  PERSONALISATION_LIMITS,
  PersonalisationEvents,
  PersonalisationService,
  personalisationIn,
  personalisationPrice,
  type PersonalisationField,
  type PersonalisationFieldInput,
  type PersonalisationKindValue,
} from '../internal/personalisation.js';
export {
  PRICE_SALE_LIMITS,
  PriceSaleEvents,
  PriceSaleService,
  runningSalesIn,
  salePrice,
  type PriceSaleInput,
  type PriceSaleRecord,
  type PriceSaleState,
  type PriceSaleUpdatedPayload,
} from '../internal/price-sales.js';
export {
  COPY_DRAFT_LIMITS,
  COPY_LANGUAGES,
  CopyDraftService,
  type CopyDraftInput,
  type CopyDraftingRecord,
} from '../internal/copy-drafts.service.js';
export {
  EASTERN_WEAR_LIMITS,
  EASTERN_WEAR_WORDS,
  FABRICS,
  SEASONS,
  STITCHING,
  piecesWords,
  type EasternWear,
  type EasternWearInput,
  type Fabric,
  type Season,
  type Stitching,
} from '../internal/eastern-wear.js';
export {
  PRODUCT_CATEGORIES,
  PRODUCT_CONDITIONS,
  productCategoryOf,
  type ProductCategory,
  type ProductCondition,
} from '../internal/taxonomy.js';
export { COPY_LANGUAGE, CopyLanguage } from '../internal/graphql/copy-language.js';
export {
  MEASUREMENTS,
  MEASUREMENT_KEYS,
  STITCHED,
  STITCHING_LIMITS,
  STITCHING_PROPERTY,
  StitchingEvents,
  StitchingService,
  isMeasurement,
  isStitched,
  measurementProperty,
  stitchingIn,
  stitchingPrice,
  stitchingProblem,
  type MeasurementKey,
  type StitchingOffer,
  type StitchingProblem,
} from '../internal/stitching.js';
export {
  DIGITAL_LIMITS,
  DigitalProductEvents,
  DigitalProductService,
  digitalFilesIn,
  digitalIn,
  digitalProductIdsIn,
  issueLicenceKeyIn,
  keysIssuedIn,
  type DigitalFileRecord,
  type DigitalProductRecord,
} from '../internal/digital-products.js';
export {
  DOWNLOAD_LINK_PATH,
  DigitalDeliveryService,
  deliverDigitalIn,
  type DigitalLine,
} from '../internal/digital-deliveries.js';
export {
  EXPANSION_AUTO_COPY,
  EXPANSION_STORE_LIMITS,
  ExpansionStoreService,
  type ExpansionCollectionMargin,
  type ExpansionProductMargin,
  type ExpansionCopyDue,
  type ExpansionStoreRecord,
  type ExpansionCopyResult,
} from '../internal/expansion-stores.service.js';
export {
  SELLING_PLAN_LIMITS,
  SELLING_PLAN_PROPERTY,
  SellingPlanEvents,
  SellingPlanService,
  planOfLine,
  planSells,
  planPrice,
  sellingPlanPropertyOf,
  sellingPlansForIn,
  sellingPlansIn,
  type SellingPlanInterval,
  type SellingPlanRecord,
} from '../internal/selling-plans.js';
