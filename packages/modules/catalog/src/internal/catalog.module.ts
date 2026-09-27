import { Module } from '@nestjs/common';
import { ProductResolver } from './graphql/product.resolver.js';
import { ProductService } from './product.service.js';

/** Needs a {@link Database} provider from the host application. */
@Module({
  providers: [ProductService, ProductResolver],
  exports: [ProductService],
})
export class CatalogModule {}
