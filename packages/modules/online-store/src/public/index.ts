// The online store's public surface. Everything under src/internal is private to this module.
export {
  OnlineStoreEvents,
  type MenuChangedPayload,
  type PageChangedPayload,
  type PageUpdatedPayload,
  type PreferencesUpdatedPayload,
  type ThemeCreatedPayload,
  type ThemeDeletedPayload,
  type ThemePublishedPayload,
  type ThemeUpdatedPayload,
} from '../internal/events.js';
export { OnlineStoreModule } from '../internal/online-store.module.js';
export type {
  MenuItemRecord,
  MenuItemTypeValue,
  MenuRecord,
  PageRecord,
  PreferencesRecord,
  ThemeFileRecord,
  ThemeRecord,
} from '../internal/records.js';
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
export {
  ThemeService,
  type ListThemesOptions,
  type ThemeFileInput,
} from '../internal/theme.service.js';
