import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeftRight,
  Headset,
  House,
  LogOut,
  Menu,
  Package,
  ReceiptText,
  Settings,
  Tag,
  Truck,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useMe, useSession, useSessionStore } from '../auth/context';
import { READS_CUSTOMERS } from '../customers/customers-page';
import { MANAGES_DISCOUNTS } from '../discounts/discounts-page';
import { OPENS_SETTINGS } from '../settings/settings-page';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { Button } from '../ui/button';
import { EmptyState, ErrorState, Loading } from '../ui/feedback';
import { LanguageToggle } from '../ui/language-toggle';
import { ShopProvider } from './shop-context';

interface NavItem {
  to:
    | '/$shopId'
    | '/$shopId/orders'
    | '/$shopId/desk'
    | '/$shopId/products'
    | '/$shopId/customers'
    | '/$shopId/shipping'
    | '/$shopId/discounts'
    | '/$shopId/settings';
  label: MessageKey;
  /** A shorter name for the phone's bottom bar, where the label is too long. */
  short?: MessageKey;
  icon: LucideIcon;
  /** Roles that see it (docs/design/02 §6); every role when missing. */
  roles?: readonly StaffRole[];
  /** Whether it is active on its own path alone, not the paths under it. */
  exact?: boolean;
  /** Kept in the phone's bottom bar when there are more sections than it holds. */
  primary?: boolean;
}

/** Sections the phone's bottom bar holds (docs/design/02 §3); past them, "More" lists the rest. */
const BOTTOM_SLOTS = 5;

/** The admin's sections, as far as they are built; the rest join as they come. */
export const NAV: readonly NavItem[] = [
  { to: '/$shopId', label: 'nav.home', icon: House, exact: true, primary: true },
  { to: '/$shopId/orders', label: 'nav.orders', icon: ReceiptText, primary: true },
  {
    to: '/$shopId/desk',
    label: 'nav.desk',
    short: 'nav.deskShort',
    icon: Headset,
    roles: ['owner', 'manager', 'confirmation_agent'],
    primary: true,
  },
  {
    to: '/$shopId/shipping',
    label: 'nav.shipping',
    icon: Truck,
    roles: ['owner', 'manager', 'packer'],
    primary: true,
  },
  { to: '/$shopId/products', label: 'nav.products', icon: Package },
  {
    to: '/$shopId/customers',
    label: 'nav.customers',
    icon: Users,
    roles: READS_CUSTOMERS,
  },
  { to: '/$shopId/discounts', label: 'nav.discounts', icon: Tag, roles: MANAGES_DISCOUNTS },
  { to: '/$shopId/settings', label: 'nav.settings', icon: Settings, roles: OPENS_SETTINGS },
];

/** The sections a role sees. */
export function sectionsOf(role: StaffRole): NavItem[] {
  return NAV.filter((item) => !item.roles || item.roles.includes(role));
}

/** Those the phone's bottom bar shows, and whether "More" has the rest. */
function bottomOf(items: NavItem[]): { shown: NavItem[]; more: boolean } {
  if (items.length <= BOTTOM_SLOTS) return { shown: items, more: false };
  return { shown: items.filter((item) => item.primary).slice(0, BOTTOM_SLOTS - 1), more: true };
}

/** "More" on a phone: every section the role sees, the bottom bar's and the rest. */
export function MorePage() {
  const { t } = useLocale();
  const { shopId } = useParams({ from: '/$shopId' });
  const me = useMe();
  const role = me.data?.shops.find((each) => each.id === shopId)?.role;
  if (!role) return null;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('nav.more')}
      </h1>
      <nav
        aria-label={t('nav.more')}
        className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
      >
        {sectionsOf(role).map((item) => (
          <Link
            key={item.to}
            to={item.to}
            params={{ shopId }}
            className="flex min-h-14 items-center gap-3 px-4"
          >
            <item.icon aria-hidden className="size-6 text-secondary" />
            {t(item.label)}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/**
 * The frame of a shop's admin (docs/design/02 §2-3): a sidebar on wide screens, a bottom bar on
 * phones, the shop's name, the language and signing out. It lets the member in only to a shop
 * they work in, and sends one whose role needs the second step to turn it on first.
 */
export function Shell() {
  const { t } = useLocale();
  const { shopId } = useParams({ from: '/$shopId' });
  const me = useMe();
  const session = useSession();
  const store = useSessionStore();
  const navigate = useNavigate();
  const shop = me.data?.shops.find((each) => each.id === shopId);
  const needsTwoStep =
    shop?.mfaRequired === true && !(me.data?.session.mfaVerified || session.mfaVerified);

  useEffect(() => {
    if (needsTwoStep) void navigate({ to: '/two-step', search: { shop: shopId }, replace: true });
  }, [needsTwoStep, navigate, shopId]);

  if (me.isPending || needsTwoStep) return <Loading label={t('state.loading')} />;
  if (me.isError) {
    return (
      <ErrorState
        message={errorText(me.error, t)}
        action={<Button onClick={() => void me.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  if (!shop) {
    return (
      <EmptyState
        title={t('shops.noAccess')}
        action={
          <Link to="/shops" className="text-primary underline-offset-4 hover:underline">
            {t('shops.title')}
          </Link>
        }
      />
    );
  }

  const items = sectionsOf(shop.role);
  const bottom = bottomOf(items);
  const signOut = async () => {
    await store.signOut();
    await navigate({ to: '/sign-in' });
  };

  return (
    <ShopProvider value={shop}>
      <div className="flex min-h-dvh bg-canvas">
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-e border-line bg-surface md:flex">
          <div className="p-4 font-semibold text-primary">{t('app.name')}</div>
          <nav aria-label={t('nav.main')} className="flex flex-col gap-1 px-2">
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                params={{ shopId }}
                activeOptions={{ exact: item.exact ?? false }}
                className="flex min-h-10 items-center gap-3 rounded-control px-3 text-secondary hover:bg-canvas data-[status=active]:bg-canvas data-[status=active]:font-medium data-[status=active]:text-primary"
              >
                <item.icon aria-hidden className="size-5" />
                {t(item.label)}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-4 py-2">
            <span dir="auto" className="truncate font-semibold">
              {shop.name}
            </span>
            {(me.data?.shops.length ?? 0) > 1 && (
              <Link
                to="/shops"
                aria-label={t('nav.switchShop')}
                className="inline-flex min-h-12 items-center rounded-control px-2 text-secondary hover:bg-canvas md:min-h-10"
              >
                <ArrowLeftRight aria-hidden className="size-5" />
              </Link>
            )}
            <span className="flex-1" />
            <LanguageToggle />
            <button
              type="button"
              onClick={() => void signOut()}
              aria-label={t('action.signOut')}
              className="inline-flex min-h-12 items-center gap-2 rounded-control px-3 text-secondary hover:bg-canvas md:min-h-10"
            >
              <LogOut aria-hidden className="size-5 rtl:-scale-x-100" />
              <span className="hidden md:inline">{t('action.signOut')}</span>
            </button>
          </header>
          <main className="flex-1 p-4 pb-24 md:p-6 md:pb-6">
            <Outlet />
          </main>
          <nav
            aria-label={t('nav.main')}
            className="fixed inset-x-0 bottom-0 z-10 grid border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
            style={{
              gridTemplateColumns: `repeat(${bottom.shown.length + (bottom.more ? 1 : 0)}, minmax(0, 1fr))`,
            }}
          >
            {bottom.shown.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                params={{ shopId }}
                activeOptions={{ exact: item.exact ?? false }}
                className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-secondary data-[status=active]:text-primary"
              >
                <item.icon aria-hidden className="size-6" />
                <span className="text-[length:var(--hatti-type-caption-size)]">
                  {t(item.short ?? item.label)}
                </span>
              </Link>
            ))}
            {bottom.more && (
              <Link
                to="/$shopId/more"
                params={{ shopId }}
                className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-secondary data-[status=active]:text-primary"
              >
                <Menu aria-hidden className="size-6" />
                <span className="text-[length:var(--hatti-type-caption-size)]">
                  {t('nav.more')}
                </span>
              </Link>
            )}
          </nav>
        </div>
      </div>
    </ShopProvider>
  );
}
