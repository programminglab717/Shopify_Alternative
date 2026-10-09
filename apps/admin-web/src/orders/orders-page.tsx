import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronRight, Download, EyeOff, FilePen, Inbox, Search, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSessionStore } from '../auth/context';
import { TAKES_DRAFTS } from '../drafts/drafts-page';
import {
  OrderBulkConfirmMutation,
  OrderBulkMarkPackedMutation,
  OrdersQuery,
} from '../api/operations';
import type { OrderBulkData, OrderListItem, OrderStage, OrdersData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminMutation, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { EXPORTS_ORDERS } from './export-page';
import { StageBadge, STAGES } from './stage';

/** The stage tabs, in the pipeline's order (docs/design/02 §1). */
const TABS: readonly (OrderStage | null)[] = [
  null,
  'NEEDS_CONFIRMATION',
  'NEEDS_REVIEW',
  'AWAITING_PAYMENT',
  'TO_PACK',
  'TO_BOOK',
  'IN_TRANSIT',
  'DELIVERED',
  'RETURNING',
  'RETURNED',
  'CANCELLED',
];

/** What a tab's selected orders can be moved on by, at once (ORD-05). */
const BULK: Partial<Record<OrderStage, 'confirm' | 'pack'>> = {
  NEEDS_CONFIRMATION: 'confirm',
  NEEDS_REVIEW: 'confirm',
  TO_PACK: 'pack',
};

const PAGE = 50;

/** The orders list's search: a stage tab and the words searched for. */
export interface OrdersSearch {
  stage?: OrderStage;
  q?: string;
}

export function validateOrdersSearch(search: Record<string, unknown>): OrdersSearch {
  const stage =
    typeof search.stage === 'string' && search.stage in STAGES
      ? (search.stage as OrderStage)
      : undefined;
  const q = typeof search.q === 'string' && search.q.trim() ? search.q.trim() : undefined;
  return { stage, q };
}

function OrderRow({
  order,
  timezone,
  selectable,
  selected,
  onSelect,
}: {
  order: OrderListItem;
  timezone: string;
  selectable: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const who = order.overPlanLimit
    ? t('orders.hidden')
    : (order.customer?.displayName ?? order.shippingAddress.name ?? '');
  const items = order.lineItems.reduce((sum, line) => sum + line.quantity, 0);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          disabled={order.overPlanLimit}
          onChange={(event) => onSelect(event.target.checked)}
          aria-label={t('orders.select', { name: order.name })}
          className="size-5 shrink-0 accent-[var(--hatti-color-primary)]"
        />
      )}
      <Link
        to="/$shopId/orders/$orderId"
        params={{ shopId, orderId: order.id }}
        className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-4"
      >
        <span className="flex items-center gap-2">
          <span className="num font-semibold">{order.name}</span>
          {order.risk?.level === 'HIGH' && (
            <span className="inline-flex items-center gap-1 text-danger">
              <ShieldAlert aria-hidden className="size-4" />
              <span className="text-[length:var(--hatti-type-body-sm-size)]">
                {t('orders.risk.HIGH')}
              </span>
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1 text-secondary">
          {order.overPlanLimit && <EyeOff aria-hidden className="size-4 shrink-0" />}
          <span className="truncate">
            {who}
            {who && order.shippingAddress.city ? ' · ' : ''}
            {order.shippingAddress.city}
          </span>
        </span>
        <span className="flex items-center gap-3">
          <StageBadge stage={order.stage} />
          <span className="num font-medium">
            {formatMoney(order.totalPrice.amount, order.totalPrice.currencyCode)}
          </span>
        </span>
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)] md:w-32 md:text-end">
          {t('orders.items', { count: items })} ·{' '}
          {formatRelative(order.createdAt, timezone, locale)}
        </span>
      </Link>
      <ChevronRight aria-hidden className="hidden size-5 text-secondary md:block rtl:rotate-180" />
    </li>
  );
}

/**
 * The orders list (ORD-01, docs/design/02 §2): a tab for each stage with its count, a search that
 * understands numbers, mobiles, tracking numbers and names, newest first a page at a time, and the
 * selected orders of the tabs that move on together confirmed or packed at once (ORD-05).
 */
export function OrdersPage() {
  const { t } = useLocale();
  const timezone = useShopTimezone();
  const store = useSessionStore();
  const shop = useShop();
  const navigate = useNavigate();
  const { stage, q } = useSearch({ from: '/$shopId/orders' });
  const [words, setWords] = useState(q ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<{ done: number; failed: string[] } | null>(null);
  const bulk = stage ? BULK[stage] : undefined;
  const confirm = useAdminMutation<OrderBulkData, { ids: string[] }>(OrderBulkConfirmMutation);
  const pack = useAdminMutation<OrderBulkData, { ids: string[] }>(OrderBulkMarkPackedMutation);

  const orders = useInfiniteQuery({
    queryKey: ['admin', shop.id, 'orders', stage ?? null, q ?? null],
    queryFn: ({ pageParam }) =>
      store.graphql<OrdersData>(shop.id, OrdersQuery, {
        first: PAGE,
        after: pageParam,
        query: q ?? null,
        stage: stage ?? null,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.orders.pageInfo.hasNextPage ? last.orders.pageInfo.endCursor : undefined,
  });

  const choose = (next: OrdersSearch) => {
    setSelected(new Set());
    setOutcome(null);
    void navigate({ to: '/$shopId/orders', params: { shopId: shop.id }, search: next });
  };

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    choose({ stage, q: words.trim() || undefined });
  };

  const counts = new Map(
    (orders.data?.pages[0]?.orderStageCounts ?? []).map((each) => [each.stage, each.count]),
  );
  const shown = orders.data?.pages.flatMap((page) => page.orders.nodes) ?? [];
  const selectable = shown.filter((order) => !order.overPlanLimit);

  const runBulk = async () => {
    const ids = [...selected];
    const mutation = bulk === 'pack' ? pack : confirm;
    try {
      const data = await mutation.mutateAsync({ ids });
      const payload = Object.values(data)[0]!;
      setOutcome({
        done: payload.orders.length,
        failed: payload.userErrors.map((error) => error.message),
      });
      setSelected(new Set());
    } catch (failure) {
      setOutcome({ done: 0, failed: [errorText(failure, t)] });
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('orders.title')}
        </h1>
        <span className="flex flex-wrap gap-2">
          {EXPORTS_ORDERS.includes(shop.role) && (
            <Link
              to="/$shopId/orders/export"
              params={{ shopId: shop.id }}
              search={{ stage, q }}
              className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
            >
              <Download aria-hidden className="size-5" />
              {t('exports.link')}
            </Link>
          )}
          {TAKES_DRAFTS.includes(shop.role) && (
            <Link
              to="/$shopId/drafts"
              params={{ shopId: shop.id }}
              className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
            >
              <FilePen aria-hidden className="size-5" />
              {t('drafts.title')}
            </Link>
          )}
        </span>
      </div>
      <form onSubmit={onSearch} role="search" className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-secondary"
        />
        <input
          type="search"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          aria-label={t('orders.search')}
          placeholder={t('orders.searchHint')}
          className="min-h-12 w-full rounded-control border border-line bg-surface ps-10 pe-3 md:min-h-10"
        />
      </form>
      <div role="tablist" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
        {TABS.map((tab) => {
          const active = (tab ?? undefined) === stage;
          const count = tab ? counts.get(tab) : undefined;
          return (
            <button
              key={tab ?? 'all'}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => choose({ stage: tab ?? undefined, q })}
              className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-3 ${
                active
                  ? 'border-primary bg-primary text-on-primary'
                  : 'border-line bg-surface text-text'
              }`}
            >
              {tab ? t(STAGES[tab].label) : t('orders.all')}
              {count !== undefined && count > 0 && (
                <span className="num text-[length:var(--hatti-type-body-sm-size)]">
                  {formatCount(count)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {outcome && (
        <Alert tone={outcome.failed.length ? 'warning' : 'success'}>
          {outcome.done > 0 && <p>{t('orders.done', { count: outcome.done })}</p>}
          {outcome.failed.length > 0 && (
            <>
              <p>{t('orders.someFailed', { count: outcome.failed.length })}</p>
              <ul className="list-disc ps-5">
                {outcome.failed.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ul>
            </>
          )}
        </Alert>
      )}
      {orders.isPending ? (
        <Loading label={t('state.loading')} />
      ) : orders.isError ? (
        <ErrorState
          message={errorText(orders.error, t)}
          action={<Button onClick={() => void orders.refetch()}>{t('action.retry')}</Button>}
        />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Inbox aria-hidden className="size-8 text-secondary" />}
            title={t('orders.none')}
            body={q || stage ? undefined : t('orders.noneBody')}
          />
        </Card>
      ) : (
        <Card>
          {bulk && (
            <div className="flex items-center gap-3 border-b border-line px-4 py-2">
              <input
                type="checkbox"
                checked={selectable.length > 0 && selected.size === selectable.length}
                onChange={(event) =>
                  setSelected(
                    event.target.checked ? new Set(selectable.map((order) => order.id)) : new Set(),
                  )
                }
                aria-label={t('orders.selectAll')}
                className="size-5 accent-[var(--hatti-color-primary)]"
              />
              <span className="text-secondary">
                {t('orders.selected', { count: formatCount(selected.size) })}
              </span>
            </div>
          )}
          <ul className="divide-y divide-line">
            {shown.map((order) => (
              <OrderRow
                key={order.id}
                order={order}
                timezone={timezone}
                selectable={Boolean(bulk)}
                selected={selected.has(order.id)}
                onSelect={(on) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (on) next.add(order.id);
                    else next.delete(order.id);
                    return next;
                  })
                }
              />
            ))}
          </ul>
          {orders.hasNextPage && (
            <div className="border-t border-line p-3 text-center">
              <Button
                variant="tertiary"
                busy={orders.isFetchingNextPage}
                onClick={() => void orders.fetchNextPage()}
              >
                {t('orders.more')}
              </Button>
            </div>
          )}
        </Card>
      )}
      {bulk && selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 flex justify-center px-4 md:bottom-6">
          <Button busy={confirm.isPending || pack.isPending} onClick={() => void runBulk()}>
            {t((bulk === 'pack' ? 'orders.packSelected' : 'orders.confirmSelected') as MessageKey, {
              count: formatCount(selected.size),
            })}
          </Button>
        </div>
      )}
    </div>
  );
}
