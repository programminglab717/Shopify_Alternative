// The files module's public surface. Everything under src/internal is private to this module.
export {
  BrandService,
  LOGO_TYPES,
  shopLogoOf,
  type BrandInput,
  type BrandRecord,
  type ShopLogo,
} from '../internal/brand.service.js';
export {
  FileEvents,
  type FileCreatedPayload,
  type FileDeletedPayload,
  type ShopBrandUpdatePayload,
} from '../internal/events.js';
export {
  FILE_LIMITS,
  FILE_URL_SECONDS,
  FileService,
  UPLOAD_SECONDS,
  type FileCreateInput,
  type StagedUploadInput,
} from '../internal/file.service.js';
export { FILE_TYPES, type FileTypeValue } from '../internal/file-types.js';
export { FilesModule } from '../internal/files.module.js';
export { toShopBrand } from '../internal/graphql/brand.resolver.js';
export { ShopBrand } from '../internal/graphql/file.types.js';
export type { FileRecord, StagedUpload } from '../internal/records.js';
