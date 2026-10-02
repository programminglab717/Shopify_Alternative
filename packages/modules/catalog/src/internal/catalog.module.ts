import { Module } from '@nestjs/common';
import { CollectionService } from './collection.service.js';
import { CollectionResolver } from './graphql/collection.resolver.js';
import { ProductMediaResolver } from './graphql/media.resolver.js';
import { ProductPartsResolver } from './graphql/product-parts.resolver.js';
import { ProductResolver } from './graphql/product.resolver.js';
import { MediaService } from './media.service.js';
import { OptionService } from './option.service.js';
import { ProductExportService } from './product-export.service.js';
import { StockFileService } from './stock-file.service.js';
import { ProductImportService } from './product-import.service.js';
import { ProductService } from './product.service.js';
import { StorefrontSearchController } from './search.controller.js';
import { VariantService } from './variant.service.js';

/**
 * Needs a {@link Database} provider from the host application, which also checks the storefront
 * key on the routes under /storefront/.
 */
@Module({
  providers: [
    ProductService,
    OptionService,
    VariantService,
    MediaService,
    CollectionService,
    ProductImportService,
    ProductExportService,
    StockFileService,
    ProductResolver,
    ProductPartsResolver,
    ProductMediaResolver,
    CollectionResolver,
  ],
  controllers: [StorefrontSearchController],
  exports: [
    ProductService,
    OptionService,
    VariantService,
    MediaService,
    CollectionService,
    ProductImportService,
    ProductExportService,
    StockFileService,
  ],
})
export class CatalogModule {}
