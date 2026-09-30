import { CatalogModule } from '@hatti/catalog/public';
import { Module } from '@nestjs/common';
import { MenuResolver } from './graphql/menu.resolver.js';
import { ThemeResolver } from './graphql/theme.resolver.js';
import { MenuService } from './menu.service.js';
import { ThemeService } from './theme.service.js';

/** Needs a {@link Database} provider from the host application. */
@Module({
  imports: [CatalogModule],
  providers: [ThemeService, ThemeResolver, MenuService, MenuResolver],
  exports: [ThemeService, MenuService],
})
export class OnlineStoreModule {}
