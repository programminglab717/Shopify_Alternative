import { Link, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Plus } from 'lucide-react';
import { useState } from 'react';
import { PurchaseOrdersQuery } from '../api/operations';
import type { PurchaseOrderStatus, PurchaseOrdersData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { EDITS_STOCK } from '../stock/stock-page';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

export const STATUS_LABELS: Record<PurchaseOrderStatus, MessageKey> = {
  OPEN: 'po.status.OPEN',
  RECEIVED: 'po.status.RECEIVED',
  CLOSED: 'po.status.CLOSED',
};

export interface PurchaseOrdersSearch {
  /** Only the orders from this supplier. */
  supplier?: string;
}

export function validatePurchaseOrdersSearch(
  search: Record<string, unknown>,
): PurchaseOrdersSearch {
  return { supplier: typeof search.supplier === 'string' ? search.supplier : undefined };
}

/** A day the goods are expected, as the core keeps it (YYYY-MM-DD), in words. */
export function useDay() {
  const { locale } = useLocale();
  return (day: string) => formatDate(`${day}T12:00:00Z`, 'UTC', locale);
}

/**
 * Purchase orders (INV-05): goods ordered from suppliers, those still to come first, each with
 * how much of it came. Every role sees them; those who change stock order and receive.
 */
export function PurchaseOrdersPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  const day = useDay();
  const { supplier } = useSearch({ from: '/$shopId/purchase-orders' });
  const [status, setStatus] = useState<PurchaseOrderStatus>('OPEN');
  const [after, setAfter] = useState<string | null>(null);
  const query = useAdminQuery<PurchaseOrdersData>(
    ['purchaseOrders'],
    PurchaseOrdersQuery,
    { status, after, supplierId: supplier ?? null },
    { keepPrevious: true },
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        to="/$shopId/stock"
        params={{ shopId }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('stock.title')}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('po.title')}
        </h1>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/$shopId/purchase-orders/suppliers"
            params={{ shopId }}
            className="inline-flex min-h-12 items-center rounded-control border border-line bg-surface px-4 font-medium hover:bg-canvas md:min-h-10"
          >
            {t('po.suppliers')}
          </Link>
          {EDITS_STOCK.includes(role) && (
            <Link
              to="/$shopId/purchase-orders/new"
              params={{ shopId }}
              className="inline-flex min-h-12 items-center gap-2 rounded-control bg-primary px-4 font-medium text-on-primary md:min-h-10"
            >
              <Plus aria-hidden className="size-5" />
              {t('po.new')}
            </Link>
          )}
        </div>
      </div>
      {supplier && (
        <p className="flex flex-wrap items-center gap-2">
          {t('po.fromOne')}
          <Link
            to="/$shopId/purchase-orders"
            params={{ shopId }}
            className="font-medium text-primary underline"
          >
            {t('po.fromAll')}
          </Link>
        </p>
      )}
      <div role="tablist" className="flex gap-2 overflow-x-auto pb-1">
        {(Object.keys(STATUS_LABELS) as PurchaseOrderStatus[]).map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={each === status}
            onClick={() => {
              setStatus(each);
              setAfter(null);
            }}
            className={`inline-flex min-h-10 shrink-0 items-center rounded-full border px-3 ${
              each === status
                ? 'border-primary bg-primary text-on-primary'
                : 'border-line bg-surface text-text'
            }`}
          >
            {t(STATUS_LABELS[each])}
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
      ) : query.data.purchaseOrders.nodes.length === 0 ? (
        <EmptyState title={t(status === 'OPEN' ? 'po.noneOpen' : 'po.none')} />
      ) : (
        <Card>
          <ul className="flex flex-col divide-y divide-line">
            {query.data.purchaseOrders.nodes.map((order) => (
              <li key={order.id}>
                <Link
                  to="/$shopId/purchase-orders/$purchaseOrderId"
                  params={{ shopId, purchaseOrderId: order.id }}
                  className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-canvas"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">
                      {order.name} · <span dir="auto">{order.supplier.name}</span>
                    </span>
                    <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                      <span dir="auto">{order.location.name}</span>
                      {order.expectedOn &&
                        ` · ${t('po.expected', { date: day(order.expectedOn) })}`}
                    </span>
                  </span>
                  <span className="num text-secondary">
                    {t('po.receivedOf', {
                      received: formatCount(order.receivedQuantity),
                      count: formatCount(order.totalQuantity),
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {query.data?.purchaseOrders.pageInfo.hasNextPage && (
        <Button
          variant="secondary"
          className="self-center"
          onClick={() => setAfter(query.data.purchaseOrders.pageInfo.endCursor)}
        >
          {t('po.older')}
        </Button>
      )}
    </div>
  );
}
