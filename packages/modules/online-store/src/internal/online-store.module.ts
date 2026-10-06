import { CatalogModule } from '@hatti/catalog/public';
import { Module } from '@nestjs/common';
import { ArticleService } from './article.service.js';
import { BlogService } from './blog.service.js';
import { StorefrontCommentsController } from './comment.controller.js';
import { CommentService } from './comment.service.js';
import { DomainService } from './domain.service.js';
import { ArticleResolver, BlogResolver } from './graphql/blog.resolver.js';
import { ArticleCommentsResolver, CommentResolver } from './graphql/comment.resolver.js';
import { DomainResolver } from './graphql/domain.resolver.js';
import { LinkTapsResolver } from './graphql/link-taps.resolver.js';
import { MenuResolver } from './graphql/menu.resolver.js';
import { PageResolver } from './graphql/page.resolver.js';
import { PolicyResolver } from './graphql/policy.resolver.js';
import { PreferencesResolver } from './graphql/preferences.resolver.js';
import { ThemeResolver } from './graphql/theme.resolver.js';
import { UrlRedirectResolver } from './graphql/url-redirect.resolver.js';
import { LinkTapsService } from './link-taps.service.js';
import { MenuService } from './menu.service.js';
import { PageService } from './page.service.js';
import { PolicyService } from './policy.service.js';
import { PreferencesService } from './preferences.service.js';
import { SessionDaysService } from './session-days.service.js';
import { StorefrontThemePreviewController } from './theme-preview.controller.js';
import { StorefrontContentSearchController } from './content-search.js';
import { ThemePreviewService } from './theme-preview.js';
import { ThemeService } from './theme.service.js';
import { UrlRedirectService } from './url-redirect.service.js';

/**
 * Needs {@link Database}, {@link StorefrontSite}, {@link DnsLookup} and {@link SecretBox}
 * providers from the host application.
 */
@Module({
  imports: [CatalogModule],
  providers: [
    ThemeService,
    ThemeResolver,
    ThemePreviewService,
    MenuService,
    MenuResolver,
    PageService,
    PageResolver,
    BlogService,
    BlogResolver,
    ArticleService,
    ArticleResolver,
    CommentService,
    CommentResolver,
    ArticleCommentsResolver,
    PreferencesService,
    PreferencesResolver,
    DomainService,
    DomainResolver,
    UrlRedirectService,
    UrlRedirectResolver,
    PolicyService,
    PolicyResolver,
    SessionDaysService,
    LinkTapsService,
    LinkTapsResolver,
  ],
  controllers: [
    StorefrontThemePreviewController,
    StorefrontContentSearchController,
    StorefrontCommentsController,
  ],
  exports: [
    ThemeService,
    MenuService,
    PageService,
    BlogService,
    ArticleService,
    CommentService,
    PreferencesService,
    DomainService,
    UrlRedirectService,
    PolicyService,
    SessionDaysService,
    LinkTapsService,
  ],
})
export class OnlineStoreModule {}
