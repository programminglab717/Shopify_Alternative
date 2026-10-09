import { Link } from '@tanstack/react-router';
import {
  BadgeCheck,
  Banknote,
  ChevronRight,
  CreditCard,
  History,
  Landmark,
  LifeBuoy,
  ListChecks,
  MapPin,
  MessageSquareText,
  Percent,
  Receipt,
  Store,
  Truck,
  UserCog,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { StaffMemberRole } from '../api/types';
import type { StaffRole } from '../auth/session';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useShop } from '../shell/shop-context';
import { Card } from '../ui/feedback';

/** The roles that open settings (docs/design/02 §6); accountants' tax and billing come later. */
export const OPENS_SETTINGS: readonly StaffRole[] = ['owner', 'manager'];

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
    | '/$shopId/settings/billing'
    | '/$shopId/settings/activity'
    | '/$shopId/settings/support'
    | '/$shopId/settings/tax'
    | '/$shopId/settings/messages'
    | '/$shopId/settings/orders'
    | '/$shopId/settings/checkout'
    | '/$shopId/settings/couriers'
    | '/$shopId/settings/staff';
  label: MessageKey;
  hint: MessageKey;
  icon: LucideIcon;
}

const SECTIONS: readonly Section[] = [
  {
    to: '/$shopId/settings/shop',
    label: 'settings.shop',
    hint: 'settings.shopHint',
    icon: Store,
  },
  {
    to: '/$shopId/settings/orders',
    label: 'settings.orders',
    hint: 'settings.ordersHint',
    icon: ListChecks,
  },
  {
    to: '/$shopId/settings/delivery',
    label: 'settings.delivery',
    hint: 'settings.deliveryHint',
    icon: MapPin,
  },
  {
    to: '/$shopId/settings/cash-on-delivery',
    label: 'settings.cashOnDelivery',
    hint: 'settings.cashOnDeliveryHint',
    icon: Banknote,
  },
  {
    to: '/$shopId/settings/bank-transfer',
    label: 'settings.bankTransfer',
    hint: 'settings.bankTransferHint',
    icon: Landmark,
  },
  {
    to: '/$shopId/settings/checkout',
    label: 'settings.checkout',
    hint: 'settings.checkoutHint',
    icon: BadgeCheck,
  },
  {
    to: '/$shopId/settings/tax',
    label: 'settings.tax',
    hint: 'settings.taxHint',
    icon: Percent,
  },
  {
    to: '/$shopId/settings/online-payments',
    label: 'settings.onlinePayments',
    hint: 'settings.onlinePaymentsHint',
    icon: CreditCard,
  },
  {
    to: '/$shopId/settings/messages',
    label: 'settings.messages',
    hint: 'settings.messagesHint',
    icon: MessageSquareText,
  },
  {
    to: '/$shopId/settings/couriers',
    label: 'settings.couriers',
    hint: 'settings.couriersHint',
    icon: Truck,
  },
  {
    to: '/$shopId/settings/staff',
    label: 'settings.staff',
    hint: 'settings.staffHint',
    icon: UserCog,
  },
  {
    to: '/$shopId/settings/billing',
    label: 'settings.billing',
    hint: 'settings.billingHint',
    icon: Receipt,
  },
  {
    to: '/$shopId/settings/activity',
    label: 'settings.activity',
    hint: 'settings.activityHint',
    icon: History,
  },
  {
    to: '/$shopId/settings/support',
    label: 'settings.support',
    hint: 'settings.supportHint',
    icon: LifeBuoy,
  },
];

/** Settings (docs/design/02 §4), as far as they are built: the shop, order policies, delivery and payments, the checkout page, sales tax, customer messages, couriers, staff, billing, activity and support access. */
export function SettingsPage() {
  const { t } = useLocale();
  const shopId = useShop().id;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.title')}
      </h1>
      <Card>
        <ul className="divide-y divide-line">
          {SECTIONS.map((section) => (
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
