import { Module } from '@nestjs/common';
import { FileService } from './file.service.js';
import { FileResolver } from './graphql/file.resolver.js';

/** Needs {@link Database} and {@link ObjectStorage} providers from the host application. */
@Module({
  providers: [FileService, FileResolver],
  exports: [FileService],
})
export class FilesModule {}
