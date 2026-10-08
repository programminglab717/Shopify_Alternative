import { Link } from '@tanstack/react-router';
import { ChevronRight, FilePen, Plus } from 'lucide-react';
import { useState } from 'react';
import { DraftOrdersQuery } from '../api/operations';
import type { DraftOrdersData } from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatMoney, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/** The roles that take orders as drafts over the phone or in a chat (ORD-03). */
export const TAKES_DRAFTS: readonly StaffRole[] = ['owner', 'manager', 'confirmation_agent'];

type Status = 'OPEN' | 'COMPLETED';

/**
 * Draft orders (ORD-03): those still open, put together in a chat or on a call and waiting for
 * the customer, and those placed; each opens its own page.
 */
export function DraftsPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const [status, setStatus] = useState<Status>('OPEN');
  const query = useAdminQuery<DraftOrdersData>(['draftOrders', status], DraftOrdersQuery, {
    status,
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('drafts.title')}
        </h1>
        {TAKES_DRAFTS.includes(shop.role) && (
          <Link
            to="/$shopId/drafts/new"
            params={{ shopId: shop.id }}
            className="inline-flex min-h-12 items-center gap-2 rounded-control bg-primary px-4 font-medium text-on-primary md:min-h-10"
          >
            <Plus aria-hidden className="size-5" />
            {t('drafts.new')}
          </Link>
        )}
      </div>
      <div role="tablist" className="flex gap-2">
        {(['OPEN', 'COMPLETED'] as const).map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={status === each}
            onClick={() => setStatus(each)}
            className={`min-h-10 rounded-full border px-4 ${
              status === each ? 'border-primary bg-primary text-on-primary' : 'border-line'
            }`}
          >
            {t(each === 'OPEN' ? 'drafts.open' : 'drafts.completed')}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.draftOrders.nodes.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FilePen aria-hidden className="size-8 text-secondary" />}
            title={t(status === 'OPEN' ? 'drafts.noneOpen' : 'drafts.noneCompleted')}
            body={t('drafts.noneBody')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.draftOrders.nodes.map((draft) => {
              const items = draft.lineItems.reduce((sum, line) => sum + line.quantity, 0);
              return (
                <li key={draft.id}>
                  <Link
                    to="/$shopId/drafts/$draftId"
                    params={{ shopId: shop.id, draftId: draft.id }}
                    className="flex min-h-16 items-center gap-3 px-4 py-3"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="num font-semibold">{draft.name}</span>
                        <span dir="auto">
                          {draft.shippingAddress
                            ? [draft.shippingAddress.name, draft.shippingAddress.city]
                                .filter(Boolean)
                                .join(', ')
                            : t('drafts.noAddress')}
                        </span>
                      </span>
                      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                        {t('drafts.items', { count: items })} ·{' '}
                        {formatRelative(draft.createdAt, timezone, locale)}
                      </span>
                    </span>
                    <span className="num font-medium">{formatMoney(draft.totalPrice.amount)}</span>
                    <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
