import { Link } from '@tanstack/react-router';
import {
  Archive,
  BadgeCheck,
  Banknote,
  Blocks,
  Braces,
  ChevronRight,
  CreditCard,
  Globe,
  History,
  Landmark,
  LifeBuoy,
  ListChecks,
  MapPin,
  MessageCircle,
  MessageSquareText,
  Percent,
  Receipt,
  ShieldCheck,
  Store,
  Truck,
  UserCog,
  Warehouse,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { StaffMemberRole } from '../api/types';
import { can, gate, hasCapability, permits, type Gate } from '../auth/permissions';
import type { StaffRole } from '../auth/session';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useShop } from '../shell/shop-context';
import { Card } from '../ui/feedback';

/** Those who run the shop (docs/design/02 §6); accountants' tax and billing come later. */
const RUNS_SHOP: readonly StaffRole[] = ['owner', 'manager'];

/** Those who change the shop's settings, as the core lets them (`write_settings`). */
export const SETS_SETTINGS = gate(RUNS_SHOP, 'write_settings');

/**
 * Those who manage staff: invite them, change their roles and let them go, and make the shop's
 * own roles (`manage_staff`, with `write_settings`).
 */
export const MANAGES_STAFF = gate(
  RUNS_SHOP,
  (shop) => hasCapability(shop, 'manage_staff') && can(shop, 'write_settings'),
);

/** Those who open settings: any of its sections. */
export const OPENS_SETTINGS = gate(RUNS_SHOP, (shop) =>
  SECTIONS.some((section) => permits(shop, section.gate)),
);

/** A staff role as the API names it, from the session's. */
export function apiRole(role: StaffRole): StaffMemberRole {
  return role.toUpperCase() as StaffMemberRole;
}

/** A role in the merchant's words. */
export function roleLabel(role: StaffMemberRole): MessageKey {
  return `role.${role}` as MessageKey;
}

interface Section {
  to:
    | '/$shopId/settings/shop'
    | '/$shopId/settings/online-payments'
    | '/$shopId/settings/delivery'
    | '/$shopId/settings/cash-on-delivery'
    | '/$shopId/settings/bank-transfer'
    | '/$shopId/settings/whatsapp'
    | '/$shopId/settings/billing'
    | '/$shopId/settings/activity'
    | '/$shopId/settings/support'
    | '/$shopId/settings/export'
    | '/$shopId/settings/verification'
    | '/$shopId/settings/apps'
    | '/$shopId/settings/expansion-stores'
    | '/$shopId/settings/tax'
    | '/$shopId/settings/custom-data'
    | '/$shopId/settings/messages'
    | '/$shopId/settings/orders'
    | '/$shopId/settings/checkout'
    | '/$shopId/settings/locations'
    | '/$shopId/settings/domains'
    | '/$shopId/settings/couriers'
    | '/$shopId/settings/staff';
  label: MessageKey;
  hint: MessageKey;
  icon: LucideIcon;
  /** Those who use it, as the core lets them. */
  gate: Gate;
}

const SECTIONS: readonly Section[] = [
  {
    to: '/$shopId/settings/shop',
    label: 'settings.shop',
    hint: 'settings.shopHint',
    icon: Store,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/domains',
    label: 'settings.domains',
    hint: 'settings.domainsHint',
    icon: Globe,
    gate: gate(RUNS_SHOP, 'write_domains'),
  },
  {
    to: '/$shopId/settings/orders',
    label: 'settings.orders',
    hint: 'settings.ordersHint',
    icon: ListChecks,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/locations',
    label: 'settings.locations',
    hint: 'settings.locationsHint',
    icon: Warehouse,
    gate: gate(RUNS_SHOP, 'write_locations'),
  },
  {
    to: '/$shopId/settings/delivery',
    label: 'settings.delivery',
    hint: 'settings.deliveryHint',
    icon: MapPin,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/cash-on-delivery',
    label: 'settings.cashOnDelivery',
    hint: 'settings.cashOnDeliveryHint',
    icon: Banknote,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/bank-transfer',
    label: 'settings.bankTransfer',
    hint: 'settings.bankTransferHint',
    icon: Landmark,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/checkout',
    label: 'settings.checkout',
    hint: 'settings.checkoutHint',
    icon: BadgeCheck,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/tax',
    label: 'settings.tax',
    hint: 'settings.taxHint',
    icon: Percent,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/custom-data',
    label: 'settings.customData',
    hint: 'settings.customDataHint',
    icon: Braces,
    gate: gate(RUNS_SHOP, 'write_products'),
  },
  {
    to: '/$shopId/settings/online-payments',
    label: 'settings.onlinePayments',
    hint: 'settings.onlinePaymentsHint',
    icon: CreditCard,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/messages',
    label: 'settings.messages',
    hint: 'settings.messagesHint',
    icon: MessageSquareText,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/whatsapp',
    label: 'settings.whatsapp',
    hint: 'settings.whatsappHint',
    icon: MessageCircle,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/couriers',
    label: 'settings.couriers',
    hint: 'settings.couriersHint',
    icon: Truck,
    gate: SETS_SETTINGS,
  },
  {
    to: '/$shopId/settings/staff',
    label: 'settings.staff',
    hint: 'settings.staffHint',
    icon: UserCog,
    gate: gate(RUNS_SHOP, 'read_settings'),
  },
  {
    to: '/$shopId/settings/expansion-stores',
    label: 'settings.expansion',
    hint: 'settings.expansionHint',
    icon: Globe,
    gate: gate(['owner'], 'write_products'),
  },
  {
    to: '/$shopId/settings/apps',
    label: 'settings.apps',
    hint: 'settings.appsHint',
    icon: Blocks,
    gate: gate(
      RUNS_SHOP,
      (shop) => can(shop, 'read_settings') && hasCapability(shop, 'manage_apps'),
    ),
  },
  {
    to: '/$shopId/settings/billing',
    label: 'settings.billing',
    hint: 'settings.billingHint',
    icon: Receipt,
    gate: gate(
      RUNS_SHOP,
      (shop) => can(shop, 'read_settings') && hasCapability(shop, 'see_billing'),
    ),
  },
  {
    to: '/$shopId/settings/export',
    label: 'settings.export',
    hint: 'settings.exportHint',
    icon: Archive,
    gate: gate(
      ['owner'],
      (shop) =>
        can(shop, 'read_orders') && can(shop, 'read_products') && can(shop, 'read_customers'),
    ),
  },
  {
    to: '/$shopId/settings/verification',
    label: 'settings.verification',
    hint: 'settings.verificationHint',
    icon: ShieldCheck,
    gate: gate(
      RUNS_SHOP,
      (shop) =>
        can(shop, 'read_settings') &&
        (shop.role === 'owner' || hasCapability(shop, 'see_verification')),
    ),
  },
  {
    to: '/$shopId/settings/activity',
    label: 'settings.activity',
    hint: 'settings.activityHint',
    icon: History,
    gate: gate(RUNS_SHOP, 'read_settings'),
  },
  {
    to: '/$shopId/settings/support',
    label: 'settings.support',
    hint: 'settings.supportHint',
    icon: LifeBuoy,
    gate: gate(
      RUNS_SHOP,
      (shop) => can(shop, 'read_settings') && hasCapability(shop, 'manage_support_access'),
    ),
  },
];

/** Settings (docs/design/02 §4), as far as they are built, each for those who use it: the shop, its domains, order policies, locations, delivery and payments, the checkout page, sales tax, customer messages, couriers, staff, apps, billing, the store's export, its verification by Hatti, activity and support access. */
export function SettingsPage() {
  const { t } = useLocale();
  const shop = useShop();
  const shopId = shop.id;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.title')}
      </h1>
      <Card>
        <ul className="divide-y divide-line">
          {SECTIONS.filter((section) => permits(shop, section.gate)).map((section) => (
            <li key={section.to}>
              <Link
                to={section.to}
                params={{ shopId }}
                className="flex min-h-16 items-center gap-3 px-4 py-3"
              >
                <section.icon aria-hidden className="size-6 shrink-0 text-secondary" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{t(section.label)}</span>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t(section.hint)}
                  </span>
                </span>
                <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/** The way back to settings from one of its sections. */
export function BackToSettings() {
  const { t } = useLocale();
  const shopId = useShop().id;
  return (
    <Link
      to="/$shopId/settings"
      params={{ shopId }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ChevronRight aria-hidden className="size-5 rotate-180 rtl:rotate-0" />
      {t('settings.title')}
    </Link>
  );
}
