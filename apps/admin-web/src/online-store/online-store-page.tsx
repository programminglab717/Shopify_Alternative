import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { StaffRole } from '../auth/session';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useShop } from '../shell/shop-context';
import { EmptyState } from '../ui/feedback';
import { WRITES_URDU } from '../urdu/in-urdu';
import { UrduOverview } from '../urdu/urdu-overview';
import { BlogsList } from './blogs';
import { LinkPageTab } from './link-page';
import { EDITS_MENUS, MenusList } from './menus';
import { MetaTab, SETS_META } from './meta';
import { PagesList, WRITES_PAGES } from './pages';
import { PoliciesList, SETS_POLICIES } from './policies';
import { RedirectsTab } from './redirects';
import { StorefrontPreferencesTab } from './storefront';
import { EDITS_THEMES, ThemesTab } from './themes';

export const ONLINE_STORE_TABS = [
  'pages',
  'blogs',
  'menus',
  'policies',
  'storefront',
  'themes',
  'redirects',
  'links',
  'meta',
  'urdu',
] as const;
export type OnlineStoreTab = (typeof ONLINE_STORE_TABS)[number];

/** The online store's tab, from its address: its pages unless it names another. */
export function validateOnlineStoreSearch(search: Record<string, unknown>): {
  tab?: OnlineStoreTab;
} {
  return ONLINE_STORE_TABS.includes(search.tab as OnlineStoreTab)
    ? { tab: search.tab as OnlineStoreTab }
    : {};
}

/** Each tab, who works in it, and what it shows. */
const TABS: Record<
  OnlineStoreTab,
  { label: MessageKey; roles: readonly StaffRole[]; body: () => ReactNode }
> = {
  pages: { label: 'onlineStore.pages', roles: WRITES_PAGES, body: () => <PagesList /> },
  blogs: { label: 'onlineStore.blogs', roles: WRITES_PAGES, body: () => <BlogsList /> },
  menus: { label: 'onlineStore.menus', roles: EDITS_MENUS, body: () => <MenusList /> },
  policies: {
    label: 'onlineStore.policies',
    roles: SETS_POLICIES,
    body: () => <PoliciesList />,
  },
  storefront: {
    label: 'onlineStore.storefront',
    roles: EDITS_MENUS,
    body: () => <StorefrontPreferencesTab />,
  },
  themes: { label: 'onlineStore.themes', roles: EDITS_THEMES, body: () => <ThemesTab /> },
  redirects: { label: 'onlineStore.redirects', roles: EDITS_MENUS, body: () => <RedirectsTab /> },
  links: { label: 'onlineStore.linkPage', roles: EDITS_MENUS, body: () => <LinkPageTab /> },
  meta: { label: 'onlineStore.meta', roles: SETS_META, body: () => <MetaTab /> },
  urdu: { label: 'onlineStore.urdu', roles: WRITES_URDU, body: () => <UrduOverview /> },
};

/** The roles that see the online store at all: those who work in any of its tabs. */
export const OPENS_ONLINE_STORE: readonly StaffRole[] = [
  ...new Set([...WRITES_PAGES, ...EDITS_MENUS, ...EDITS_THEMES, ...SETS_META, ...WRITES_URDU]),
];

/**
 * The online store (OS-02, OS-06, OS-07, OS-09, OS-15): the shop's pages, blogs, menus and policies,
 * its storefront's password, pause and home page for search engines, its themes, its redirects, its
 * link page, Meta and the catalog feed (MKT-10, MKT-11), and what is left to put in Urdu; a tab for
 * each part its role works in.
 */
export function OnlineStorePage() {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const search = useSearch({ from: '/$shopId/online-store' });
  const tabs = ONLINE_STORE_TABS.filter((tab) => TABS[tab].roles.includes(shop.role));
  if (tabs.length === 0) return <EmptyState title={t('pages.cannot')} />;
  const tab = search.tab && tabs.includes(search.tab) ? search.tab : tabs[0]!;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('onlineStore.title')}
      </h1>
      {tabs.length > 1 && (
        <div role="tablist" className="flex flex-wrap gap-2">
          {tabs.map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={each === tab}
              onClick={() =>
                void navigate({
                  to: '/$shopId/online-store',
                  params: { shopId: shop.id },
                  search: { tab: each },
                })
              }
              className={`inline-flex min-h-10 items-center rounded-full border px-3 ${
                each === tab
                  ? 'border-primary bg-primary text-on-primary'
                  : 'border-line bg-surface hover:bg-canvas'
              }`}
            >
              {t(TABS[each].label)}
            </button>
          ))}
        </div>
      )}
      {TABS[tab].body()}
    </div>
  );
}
