import { Module } from '@nestjs/common';
import { CollectionService } from './collection.service.js';
import { CollectionResolver } from './graphql/collection.resolver.js';
import { ProductPartsResolver } from './graphql/product-parts.resolver.js';
import { ProductResolver } from './graphql/product.resolver.js';
import { MediaService } from './media.service.js';
import { OptionService } from './option.service.js';
import { ProductService } from './product.service.js';
import { VariantService } from './variant.service.js';

/** Needs a {@link Database} provider from the host application. */
@Module({
  providers: [
    ProductService,
    OptionService,
    VariantService,
    MediaService,
    CollectionService,
    ProductResolver,
    ProductPartsResolver,
    CollectionResolver,
  ],
  exports: [ProductService, OptionService, VariantService, MediaService, CollectionService],
})
export class CatalogModule {}
