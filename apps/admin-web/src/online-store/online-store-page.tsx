import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { gate, permits, type Gate } from '../auth/permissions';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useShop } from '../shell/shop-context';
import { EmptyState } from '../ui/feedback';
import { EDITS_PRODUCTS } from '../products/status';
import { WRITES_URDU } from '../urdu/in-urdu';
import { UrduOverview } from '../urdu/urdu-overview';
import { BlogsList } from './blogs';
import { FilesTab, KEEPS_FILES } from './files';
import { FiltersTab } from './filters';
import { GoogleTab } from './google';
import { LinkPageTab } from './link-page';
import { EDITS_MENUS, MenusList } from './menus';
import { MetaTab, SETS_META } from './meta';
import { PagesList, WRITES_BLOGS, WRITES_PAGES } from './pages';
import { PoliciesList, SETS_POLICIES } from './policies';
import { RedirectsTab } from './redirects';
import { KEEPS_LISTINGS, SeoOverview } from './seo-overview';
import { SpeedTab } from './speed';
import { StoreBuilderTab } from './store-builder';
import { StorefrontPreferencesTab } from './storefront';
import { SearchRulesTab } from './search-rules';
import { SynonymsTab } from './synonyms';
import { EDITS_THEMES, ThemesTab } from './themes';
import { TikTokTab } from './tiktok';

export const ONLINE_STORE_TABS = [
  'pages',
  'blogs',
  'menus',
  'files',
  'policies',
  'storefront',
  'filters',
  'synonyms',
  'searchRules',
  'themes',
  'builder',
  'speed',
  'seo',
  'redirects',
  'links',
  'meta',
  'tiktok',
  'google',
  'urdu',
] as const;
export type OnlineStoreTab = (typeof ONLINE_STORE_TABS)[number];

/**
 * The online store's tab, from its address: its pages unless it names another; on the
 * synonyms tab, a search's words to begin a group with (ADR-686); and on the search results
 * tab, a search's words to pin products for (ADR-693).
 */
export function validateOnlineStoreSearch(search: Record<string, unknown>): {
  tab?: OnlineStoreTab;
  word?: string;
  term?: string;
} {
  const tab = ONLINE_STORE_TABS.includes(search.tab as OnlineStoreTab)
    ? (search.tab as OnlineStoreTab)
    : undefined;
  const word =
    tab === 'synonyms' && typeof search.word === 'string' && search.word.trim()
      ? search.word.trim().slice(0, 100)
      : undefined;
  const term =
    tab === 'searchRules' && typeof search.term === 'string' && search.term.trim()
      ? search.term.trim().slice(0, 100)
      : undefined;
  return { ...(tab && { tab }), ...(word && { word }), ...(term && { term }) };
}

/** Those who set the storefront's preferences, filters and link page (`write_settings`). */
const SETS_STOREFRONT = gate(['owner', 'manager'], 'write_settings');

/** Each tab, who works in it, and what it shows. */
const TABS: Record<OnlineStoreTab, { label: MessageKey; gate: Gate; body: () => ReactNode }> = {
  pages: { label: 'onlineStore.pages', gate: WRITES_PAGES, body: () => <PagesList /> },
  blogs: { label: 'onlineStore.blogs', gate: WRITES_BLOGS, body: () => <BlogsList /> },
  menus: { label: 'onlineStore.menus', gate: EDITS_MENUS, body: () => <MenusList /> },
  files: { label: 'onlineStore.files', gate: KEEPS_FILES, body: () => <FilesTab /> },
  policies: {
    label: 'onlineStore.policies',
    gate: SETS_POLICIES,
    body: () => <PoliciesList />,
  },
  storefront: {
    label: 'onlineStore.storefront',
    gate: SETS_STOREFRONT,
    body: () => <StorefrontPreferencesTab />,
  },
  filters: { label: 'onlineStore.filters', gate: SETS_STOREFRONT, body: () => <FiltersTab /> },
  synonyms: { label: 'onlineStore.synonyms', gate: EDITS_PRODUCTS, body: () => <SynonymsTab /> },
  searchRules: {
    label: 'onlineStore.searchRules',
    gate: EDITS_PRODUCTS,
    body: () => <SearchRulesTab />,
  },
  themes: { label: 'onlineStore.themes', gate: EDITS_THEMES, body: () => <ThemesTab /> },
  builder: {
    label: 'onlineStore.builder',
    gate: EDITS_THEMES,
    body: () => <StoreBuilderTab />,
  },
  speed: {
    label: 'onlineStore.speed',
    gate: gate(EDITS_THEMES.roles, 'read_themes'),
    body: () => <SpeedTab />,
  },
  seo: { label: 'onlineStore.seo', gate: KEEPS_LISTINGS, body: () => <SeoOverview /> },
  redirects: { label: 'onlineStore.redirects', gate: EDITS_MENUS, body: () => <RedirectsTab /> },
  links: { label: 'onlineStore.linkPage', gate: SETS_STOREFRONT, body: () => <LinkPageTab /> },
  meta: { label: 'onlineStore.meta', gate: SETS_META, body: () => <MetaTab /> },
  tiktok: { label: 'onlineStore.tiktok', gate: SETS_META, body: () => <TikTokTab /> },
  google: { label: 'onlineStore.google', gate: SETS_META, body: () => <GoogleTab /> },
  urdu: { label: 'onlineStore.urdu', gate: WRITES_URDU, body: () => <UrduOverview /> },
};

/** Those who see the online store at all: those who work in any of its tabs. */
export const OPENS_ONLINE_STORE = gate(
  [...new Set(ONLINE_STORE_TABS.flatMap((tab) => TABS[tab].gate.roles))],
  (shop) => ONLINE_STORE_TABS.some((tab) => permits(shop, TABS[tab].gate)),
);

/**
 * The online store (OS-02, OS-06, OS-07, OS-09, OS-15): the shop's pages, blogs, menus and policies,
 * its storefront's password, pause and home page for search engines, its filters (ADR-568), its search synonyms (ADR-686) and what a search shows first (ADR-693), its themes, its speed (OS-13), every page's
 * search engine listing (ADR-606), its redirects, its
 * link page, Meta and the catalog feed (MKT-10, MKT-11), TikTok (ADR-542), Google (ADR-550), and what is left to put in Urdu; a tab for
 * each part its role works in.
 */
export function OnlineStorePage() {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const search = useSearch({ from: '/$shopId/online-store' });
  const tabs = ONLINE_STORE_TABS.filter((tab) => permits(shop, TABS[tab].gate));
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
