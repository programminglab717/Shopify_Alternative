// The online store's public surface. Everything under src/internal is private to this module.
export {
  OnlineStoreEvents,
  type DomainChangedPayload,
  type DomainUpdatedPayload,
  type MenuChangedPayload,
  type PageChangedPayload,
  type PageUpdatedPayload,
  type PreferencesUpdatedPayload,
  type ThemeCreatedPayload,
  type ThemeDeletedPayload,
  type ThemePublishedPayload,
  type ThemeUpdatedPayload,
  type UrlRedirectChangedPayload,
} from '../internal/events.js';
export { OnlineStoreModule } from '../internal/online-store.module.js';
export type {
  DomainRecord,
  MenuItemRecord,
  MenuItemTypeValue,
  MenuRecord,
  PageRecord,
  PreferencesRecord,
  ThemeFileRecord,
  ThemeRecord,
  UrlRedirectRecord,
} from '../internal/records.js';
export { DOMAIN_LIMIT, hostOf } from '../internal/domain-name.js';
export { DomainService, shopDomainsOf } from '../internal/domain.service.js';
export { MENU_LIMITS, type MenuItemInput } from '../internal/menu-items.js';
export { MenuService, type MenuInput } from '../internal/menu.service.js';
export { PAGE_LIMITS, cleanPageBody } from '../internal/page-body.js';
export { PageService, type PageInput } from '../internal/page.service.js';
export { PreferencesService, type PreferencesInput } from '../internal/preferences.service.js';
export type { ThemeRoleValue } from '../internal/schema.js';
export {
  BASE_THEME,
  BASE_THEME_NAME,
  THEME_LIMITS,
  isThemeFilename,
} from '../internal/theme-files.js';
export { PREVIEW_DAYS, ThemePreviewService, type ThemePreview } from '../internal/theme-preview.js';
export {
  ThemeService,
  type ListThemesOptions,
  type ThemeFileInput,
} from '../internal/theme.service.js';
export { REDIRECT_LIMIT, redirectPath, redirectTarget } from '../internal/redirect-paths.js';
export {
  UrlRedirectService,
  redirectMoved,
  shopRedirectsOf,
  type UrlRedirectInput,
} from '../internal/url-redirect.service.js';
