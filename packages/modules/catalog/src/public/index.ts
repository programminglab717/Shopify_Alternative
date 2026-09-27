// The catalog's public surface. Everything under src/internal is private to this module.
export { CatalogModule } from '../internal/catalog.module.js';
export {
  CatalogEvents,
  type ProductCreatedPayload,
  type ProductUpdatedPayload,
} from '../internal/events.js';
export {
  ProductService,
  type CreateProductInput,
  type FieldError,
  type ListProductsOptions,
  type MutationResult,
  type ProductRecord,
  type UpdateProductInput,
  type VariantInput,
  type VariantRecord,
} from '../internal/product.service.js';
