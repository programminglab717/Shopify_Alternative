import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { PastOrdersQuery } from '../api/operations';
import type { PastOrderValue, PastOrdersData } from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { SeenAt } from '../offline/seen-at';
import { useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

const PAGE = 50;

/** A status as the old store wrote it, PARTIALLY_REFUNDED, in words: partially refunded. */
export const storeWords = (status: string) => status.toLowerCase().replace(/_/g, ' ');

/** A past order, whole: what it had, how it was paid and sent, and where it went. */
function PastOrderCard({ order, timezone }: { order: PastOrderValue; timezone: string }) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const address = order.shippingAddress;
  const statuses = order.cancelledAt
    ? [t('customer.pastCancelled')]
    : [order.financialStatus, order.fulfillmentStatus].filter(Boolean).map((s) => storeWords(s!));
  return (
    <li>
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="num font-semibold">{order.name}</span>
          <span className="flex-1 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {formatDate(order.placedAt, timezone, locale)}
          </span>
          <span className="num font-medium">
            {formatMoney(order.total.amount, order.total.currencyCode)}
          </span>
        </h2>
        {statuses.length > 0 && <p className="text-secondary">{statuses.join(' · ')}</p>}
        <ul className="flex flex-col gap-0.5">
          {order.lines.map((line, index) => (
            <li key={index} className="flex gap-2" dir="auto">
              <span className="num">{formatCount(line.quantity)} ×</span>
              <span className="flex-1">
                {line.title}
                {line.variantTitle && (
                  <span className="text-secondary"> ({line.variantTitle})</span>
                )}
              </span>
              <span className="num">{formatMoney(line.price.amount, line.price.currencyCode)}</span>
            </li>
          ))}
        </ul>
        <dl className="grid gap-x-4 gap-y-1 text-[length:var(--hatti-type-body-sm-size)] sm:grid-cols-2">
          {order.customerId && (
            <div>
              <dt className="text-secondary">{t('pastOrders.customer')}</dt>
              <dd>
                <Link
                  to="/$shopId/customers/$customerId"
                  params={{ shopId, customerId: order.customerId }}
                  className="underline"
                >
                  {address?.name ?? order.phone ?? t('pastOrders.theirPage')}
                </Link>
              </dd>
            </div>
          )}
          {address && (
            <div>
              <dt className="text-secondary">{t('pastOrders.shippedTo')}</dt>
              <dd dir="auto">
                {[address.address1, address.address2, address.city, address.province]
                  .filter(Boolean)
                  .join(', ')}
              </dd>
            </div>
          )}
          {order.note && (
            <div className="sm:col-span-2">
              <dt className="text-secondary">{t('pastOrders.note')}</dt>
              <dd className="whitespace-pre-line" dir="auto">
                {order.note}
              </dd>
            </div>
          )}
        </dl>
      </Card>
    </li>
  );
}

/**
 * Orders from the store the shop moved from (ONB-05, ADR-786), the latest placed first: a
 * history to look back on, each whole, linking to its customer where it found one.
 */
export function PastOrdersPage() {
  const { t } = useLocale();
  const shop = useShop();
  const store = useSessionStore();
  const timezone = useShopTimezone();
  const orders = useInfiniteQuery({
    queryKey: ['admin', shop.id, 'pastOrders'],
    queryFn: ({ pageParam }) =>
      store.graphql<PastOrdersData>(shop.id, PastOrdersQuery, { first: PAGE, after: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.pastOrders.pageInfo.hasNextPage ? last.pastOrders.pageInfo.endCursor : undefined,
  });
  const shown = orders.data?.pages.flatMap((page) => page.pastOrders.nodes) ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/orders"
        params={{ shopId: shop.id }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('orders.title')}
      </Link>
      <SeenAt at={orders.dataUpdatedAt} />
      <header className="flex flex-col gap-1">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('pastOrders.title')}
        </h1>
        <p className="text-secondary">{t('pastOrders.hint')}</p>
      </header>
      {orders.isPending ? (
        <Loading label={t('state.loading')} />
      ) : orders.isError ? (
        <ErrorState
          message={errorText(orders.error, t)}
          action={<Button onClick={() => void orders.refetch()}>{t('action.retry')}</Button>}
        />
      ) : shown.length === 0 ? (
        <EmptyState title={t('pastOrders.none')} />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {shown.map((order) => (
              <PastOrderCard key={order.id} order={order} timezone={timezone} />
            ))}
          </ul>
          {orders.hasNextPage && (
            <Button
              variant="tertiary"
              className="self-center"
              busy={orders.isFetchingNextPage}
              onClick={() => void orders.fetchNextPage()}
            >
              {t('orders.more')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
