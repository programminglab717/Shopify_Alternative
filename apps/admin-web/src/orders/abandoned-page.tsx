import { Link } from '@tanstack/react-router';
import { CircleCheck, Clock, MessageCircle, Send, TicketPercent } from 'lucide-react';
import { useState } from 'react';
import { AbandonedCheckoutsQuery } from '../api/operations';
import type { AbandonedCheckout, AbandonedCheckoutsData } from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount, formatDateTime, formatMoney, formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { OPENS_SETTINGS } from '../settings/settings-page';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/**
 * Those who see the checkouts shoppers left (CHK-12): those who work orders, and marketers, who
 * win customers back. Numbers are masked for those who see them so.
 */
export const SEES_ABANDONED: readonly StaffRole[] = [
  'owner',
  'manager',
  'confirmation_agent',
  'marketer',
];

/** The checkouts a page shows at a time. */
const PAGE = 50;

/** A shopper's number as a WhatsApp chat link: only a whole number, never a masked one. */
function whatsappOf(phone: string): string | null {
  return /^\+92\d{10}$/.test(phone) ? `https://wa.me/${phone.slice(1)}` : null;
}

function Left({ checkout }: { checkout: AbandonedCheckout }) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const chat = whatsappOf(checkout.phone);
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="font-medium" dir="auto">
            {checkout.name ?? t('abandoned.noName')}
          </span>
          <span className="num text-secondary" dir="ltr">
            {formatPhone(checkout.phone)}
          </span>
        </span>
        <span className="num font-medium">
          {formatMoney(checkout.subtotalPrice.amount, checkout.subtotalPrice.currencyCode)}
        </span>
      </div>
      <p className="text-secondary" dir="auto">
        {checkout.lineItems
          .map(
            (line) =>
              `${formatCount(line.quantity)} × ${line.title}` +
              (line.variantTitle && line.variantTitle !== 'Default Title'
                ? ` (${line.variantTitle})`
                : ''),
          )
          .join(', ')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('abandoned.left', { date: formatDateTime(checkout.abandonedAt, timezone, locale) })}
        </span>
        {checkout.recoveredOrder ? (
          <Link
            to="/$shopId/orders/$orderId"
            params={{ shopId: shop.id, orderId: checkout.recoveredOrder.id }}
            className="inline-flex"
          >
            <Badge
              colour="delivered"
              icon={CircleCheck}
              label={t('abandoned.recovered', { name: checkout.recoveredOrder.name })}
            />
          </Link>
        ) : checkout.offeredAt ? (
          <Badge
            colour="confirmed"
            icon={TicketPercent}
            label={t('abandoned.offered', {
              code: checkout.offerCode ?? '',
              date: formatDateTime(checkout.offeredAt, timezone, locale),
            })}
          />
        ) : checkout.remindedAt ? (
          <Badge
            colour="confirmed"
            icon={Send}
            label={t('abandoned.reminded', {
              date: formatDateTime(checkout.remindedAt, timezone, locale),
            })}
          />
        ) : (
          <Badge colour="needsConfirmation" icon={Clock} label={t('abandoned.notReminded')} />
        )}
        {chat && !checkout.recoveredOrder && (
          <a
            href={chat}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-10 items-center gap-1 font-medium text-primary hover:underline"
          >
            <MessageCircle aria-hidden className="size-5" />
            {t('abandoned.chat')}
          </a>
        )}
      </div>
    </Card>
  );
}

/**
 * Checkouts shoppers left after typing their number (CHK-12, ADR-393), the latest first: who,
 * what they would have ordered, and whether they were reminded on WhatsApp, offered a code after
 * (ADR-426), or ordered since. The reminder and the offer are the shop's to set, in Settings,
 * which the page points owners and managers to.
 */
export function AbandonedPage() {
  const { t } = useLocale();
  const shop = useShop();
  const [after, setAfter] = useState<string[]>([]);
  const cursor = after.at(-1) ?? null;
  const query = useAdminQuery<AbandonedCheckoutsData>(
    ['abandonedCheckouts', cursor],
    AbandonedCheckoutsQuery,
    { first: PAGE, after: cursor },
  );

  const heading = (
    <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
      {t('abandoned.title')}
    </h1>
  );
  if (query.isPending) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {heading}
        <Loading label={t('state.loading')} />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {heading}
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      </div>
    );
  }
  const { abandonedCheckouts: left, checkoutRecoverySettings: recovery } = query.data;
  const minutes = recovery.reminderAfterMinutes;
  const offer = minutes === null ? null : (recovery.offerDiscountCode ?? null);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      {heading}
      <p className="text-secondary">
        {minutes === null
          ? t('abandoned.remindersOff')
          : t('abandoned.remindersOn', {
              after: t(`checkoutPage.reminder.${minutes}` as MessageKey).toLowerCase(),
            })}{' '}
        {offer &&
          `${t('abandoned.offerOn', {
            code: offer.code,
            after: t(
              `checkoutPage.offerAfter.${recovery.offerAfterHours ?? 24}` as MessageKey,
            ).toLowerCase(),
          })} `}
        {OPENS_SETTINGS.includes(shop.role) && (
          <Link
            to="/$shopId/settings/checkout"
            params={{ shopId: shop.id }}
            className="font-medium text-primary hover:underline"
          >
            {t('abandoned.change')}
          </Link>
        )}
      </p>
      {left.length === 0 ? (
        <EmptyState title={after.length > 0 ? t('abandoned.noMore') : t('abandoned.none')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {left.map((checkout) => (
            <li key={checkout.id}>
              <Left checkout={checkout} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {after.length > 0 && (
          <Button variant="secondary" onClick={() => setAfter((all) => all.slice(0, -1))}>
            {t('abandoned.newer')}
          </Button>
        )}
        {left.length === PAGE && (
          <Button variant="secondary" onClick={() => setAfter((all) => [...all, left.at(-1)!.id])}>
            {t('abandoned.older')}
          </Button>
        )}
      </div>
    </div>
  );
}
