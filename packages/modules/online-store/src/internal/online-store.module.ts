import { Module } from '@nestjs/common';
import { ThemeResolver } from './graphql/theme.resolver.js';
import { ThemeService } from './theme.service.js';

/** Needs a {@link Database} provider from the host application. */
@Module({
  providers: [ThemeService, ThemeResolver],
  exports: [ThemeService],
})
export class OnlineStoreModule {}
