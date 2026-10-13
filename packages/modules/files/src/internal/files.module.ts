import { Module } from '@nestjs/common';
import { BrandService } from './brand.service.js';
import { FileService } from './file.service.js';
import { BrandResolver } from './graphql/brand.resolver.js';
import { FileResolver } from './graphql/file.resolver.js';
import { StoreExportResolver } from './graphql/store-export.resolver.js';
import { StoreExportService } from './store-export.service.js';

/**
 * Needs {@link Database} and {@link ObjectStorage} providers from the host application, whose
 * Shop type shows the shop's brand.
 */
@Module({
  providers: [
    FileService,
    FileResolver,
    BrandService,
    BrandResolver,
    StoreExportService,
    StoreExportResolver,
  ],
  exports: [FileService, BrandService, StoreExportService],
})
export class FilesModule {}
