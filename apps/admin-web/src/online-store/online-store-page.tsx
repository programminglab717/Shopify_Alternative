import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { StaffRole } from '../auth/session';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useShop } from '../shell/shop-context';
import { EmptyState } from '../ui/feedback';
import { EDITS_MENUS, MenusList } from './menus';
import { PagesList, WRITES_PAGES } from './pages';

export const ONLINE_STORE_TABS = ['pages', 'menus'] as const;
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
  menus: { label: 'onlineStore.menus', roles: EDITS_MENUS, body: () => <MenusList /> },
};

/** The roles that see the online store at all: those who work in any of its tabs. */
export const OPENS_ONLINE_STORE: readonly StaffRole[] = [
  ...new Set([...WRITES_PAGES, ...EDITS_MENUS]),
];

/** The online store (OS-07): the shop's pages and menus, a tab for each part its role works in. */
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
        <div role="tablist" className="flex gap-2">
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
