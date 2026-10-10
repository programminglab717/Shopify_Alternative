import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  ArrowDownUp,
  Ban,
  ChevronRight,
  Search,
  ShieldX,
  Tags,
  UserPlus,
  Users,
  UsersRound,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { CustomersQuery } from '../api/operations';
import type { CustomerListItem, CustomersData } from '../api/types';
import { useSessionStore } from '../auth/context';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney, formatPhone, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { BulkOutcome } from '../orders/bulk';
import { useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { CustomerTagsPanel } from './bulk';
import { MOVES_CUSTOMERS } from './transfer-page';

const PAGE = 50;

/** The roles that see customers; packers and accountants see none (docs/design/02 §6). */
export const READS_CUSTOMERS: readonly StaffRole[] = [
  'owner',
  'manager',
  'confirmation_agent',
  'marketer',
];

/** Those who keep segments, for marketing: owners, managers and marketers (CUS-03). */
export const KEEPS_SEGMENTS: readonly StaffRole[] = ['owner', 'manager', 'marketer'];

/** Who adds customers by hand and sees the erasures waiting (CUS-01, CUS-05). */
const ADDS_CUSTOMERS: readonly StaffRole[] = ['owner', 'manager'];

/** The customers list's search: the words searched for. */
export interface CustomersSearch {
  q?: string;
}

export function validateCustomersSearch(search: Record<string, unknown>): CustomersSearch {
  return typeof search.q === 'string' && search.q.trim() ? { q: search.q.trim() } : {};
}

/** A number as staff may see it: whole and formatted, or masked as the core gave it. */
export function shownPhone(phone: string): string {
  return phone.includes('•') ? phone : formatPhone(phone);
}

export function CustomerRow({
  customer,
  timezone,
  selection,
}: {
  customer: CustomerListItem;
  timezone: string;
  /** Whether the customer is chosen, where customers are chosen on the list. */
  selection?: { selected: boolean; onSelect: (selected: boolean) => void };
}) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  return (
    <li className="flex items-center gap-3 ps-4">
      {selection && (
        <input
          type="checkbox"
          checked={selection.selected}
          onChange={(event) => selection.onSelect(event.target.checked)}
          aria-label={t('orders.select', { name: customer.displayName })}
          className="size-5 shrink-0 accent-[var(--hatti-color-primary)]"
        />
      )}
      <Link
        to="/$shopId/customers/$customerId"
        params={{ shopId, customerId: customer.id }}
        className="flex min-w-0 flex-1 items-center gap-3 py-3 pe-4"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-4">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate font-medium" dir="auto">
              {customer.displayName}
            </span>
            {customer.blocklistEntry && (
              <span className="inline-flex shrink-0 items-center gap-1 text-danger text-[length:var(--hatti-type-body-sm-size)]">
                <Ban aria-hidden className="size-4" />
                {t('customers.blocked')}
              </span>
            )}
          </span>
          <span className="num text-secondary md:w-36">{shownPhone(customer.phone)}</span>
          <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)] md:w-48">
            {t('customers.orders', { count: customer.numberOfOrders })}
            {customer.lastOrderAt && ` · ${formatRelative(customer.lastOrderAt, timezone, locale)}`}
          </span>
          <span className="num font-medium md:w-28 md:text-end">
            {formatMoney(customer.amountSpent.amount, customer.amountSpent.currencyCode)}
          </span>
        </span>
        <ChevronRight
          aria-hidden
          className="hidden size-5 text-secondary md:block rtl:rotate-180"
        />
      </Link>
    </li>
  );
}

/**
 * The customers list (CUS-01, docs/design/02 §2): newest first, searched by any part of a mobile
 * number, a name or an email, each with their orders and what they spent; owners and managers tag
 * those they choose on it at once.
 */
export function CustomersPage() {
  const { t } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const timezone = useShopTimezone();
  const navigate = useNavigate();
  const { q } = useSearch({ from: '/$shopId/customers' });
  const [words, setWords] = useState(q ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [tagging, setTagging] = useState(false);
  const tags = ADDS_CUSTOMERS.includes(shop.role);

  const customers = useInfiniteQuery({
    queryKey: ['admin', shop.id, 'customers', q ?? null],
    queryFn: ({ pageParam }) =>
      store.graphql<CustomersData>(shop.id, CustomersQuery, {
        first: PAGE,
        after: pageParam,
        query: q ?? null,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.customers.pageInfo.hasNextPage ? last.customers.pageInfo.endCursor : undefined,
  });

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    setSelected(new Set());
    setOutcome(null);
    setTagging(false);
    void navigate({
      to: '/$shopId/customers',
      params: { shopId: shop.id },
      search: { q: words.trim() || undefined },
    });
  };

  const shown = customers.data?.pages.flatMap((page) => page.customers.nodes) ?? [];
  const names = new Map(shown.map((customer) => [customer.id, customer.displayName]));

  /** Tagging done, or put away: what came of it said, the choice cleared. */
  const doneTagging = (done: BulkOutcome | null) => {
    setTagging(false);
    if (done) {
      setOutcome(done);
      setSelected(new Set());
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('customers.title')}
        </h1>
        <div className="flex flex-wrap gap-2">
          {KEEPS_SEGMENTS.includes(shop.role) && (
            <Link
              to="/$shopId/customers/segments"
              params={{ shopId: shop.id }}
              className="inline-flex min-h-10 items-center gap-2 rounded-control border border-line bg-surface px-3 hover:bg-canvas"
            >
              <UsersRound aria-hidden className="size-5" />
              {t('segments.title')}
            </Link>
          )}
          {ADDS_CUSTOMERS.includes(shop.role) && (
            <>
              <Link
                to="/$shopId/customers/blocked"
                params={{ shopId: shop.id }}
                className="inline-flex min-h-10 items-center gap-2 rounded-control border border-line bg-surface px-3 hover:bg-canvas"
              >
                <Ban aria-hidden className="size-5" />
                {t('blocked.title')}
              </Link>
              <Link
                to="/$shopId/customers/erasures"
                params={{ shopId: shop.id }}
                className="inline-flex min-h-10 items-center gap-2 rounded-control border border-line bg-surface px-3 hover:bg-canvas"
              >
                <ShieldX aria-hidden className="size-5" />
                {t('care.erasures')}
              </Link>
              <Link
                to="/$shopId/customers/new"
                params={{ shopId: shop.id }}
                className="inline-flex min-h-10 items-center gap-2 rounded-control bg-primary px-3 font-medium text-on-primary hover:bg-primary-strong"
              >
                <UserPlus aria-hidden className="size-5" />
                {t('newCustomer.title')}
              </Link>
            </>
          )}
          {MOVES_CUSTOMERS.includes(shop.role) && (
            <Link
              to="/$shopId/customers/transfer"
              params={{ shopId: shop.id }}
              className="inline-flex min-h-10 items-center gap-2 rounded-control border border-line bg-surface px-3 hover:bg-canvas"
            >
              <ArrowDownUp aria-hidden className="size-5" />
              {t('moving.title')}
            </Link>
          )}
        </div>
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
          aria-label={t('customers.search')}
          placeholder={t('customers.searchHint')}
          className="min-h-12 w-full rounded-control border border-line bg-surface ps-10 pe-3 md:min-h-10"
        />
      </form>
      {outcome && (
        <Alert tone={outcome.failed.length ? 'warning' : 'success'}>
          {outcome.done > 0 && <p>{t('customerBulk.done', { count: outcome.done })}</p>}
          {outcome.failed.length > 0 && (
            <>
              <p>{t('orders.someFailed', { count: outcome.failed.length })}</p>
              <ul className="list-disc ps-5">
                {outcome.failed.map((message, index) => (
                  <li key={index} dir="auto">
                    {message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Alert>
      )}
      {tagging && <CustomerTagsPanel ids={[...selected]} names={names} onDone={doneTagging} />}
      {customers.isPending ? (
        <Loading label={t('state.loading')} />
      ) : customers.isError ? (
        <ErrorState
          message={errorText(customers.error, t)}
          action={<Button onClick={() => void customers.refetch()}>{t('action.retry')}</Button>}
        />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users aria-hidden className="size-8 text-secondary" />}
            title={q ? t('customers.noneFound') : t('customers.none')}
            body={q ? undefined : t('customers.noneBody')}
          />
        </Card>
      ) : (
        <Card>
          {tags && (
            <div className="flex items-center gap-3 border-b border-line px-4 py-2">
              <input
                type="checkbox"
                checked={selected.size === shown.length}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? new Set(shown.map((customer) => customer.id))
                      : new Set(),
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
            {shown.map((customer) => (
              <CustomerRow
                key={customer.id}
                customer={customer}
                timezone={timezone}
                selection={
                  tags
                    ? {
                        selected: selected.has(customer.id),
                        onSelect: (on) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (on) next.add(customer.id);
                            else next.delete(customer.id);
                            return next;
                          }),
                      }
                    : undefined
                }
              />
            ))}
          </ul>
          {customers.hasNextPage && (
            <div className="border-t border-line p-3 text-center">
              <Button
                variant="tertiary"
                busy={customers.isFetchingNextPage}
                onClick={() => void customers.fetchNextPage()}
              >
                {t('orders.more')}
              </Button>
            </div>
          )}
        </Card>
      )}
      {tags && selected.size > 0 && !tagging && (
        <div className="fixed inset-x-0 bottom-16 z-20 flex flex-wrap justify-center gap-2 px-4 md:bottom-6">
          <Button
            icon={<Tags aria-hidden className="size-5" />}
            onClick={() => {
              setOutcome(null);
              setTagging(true);
            }}
          >
            {t('bulk.tag', { count: formatCount(selected.size) })}
          </Button>
        </div>
      )}
    </div>
  );
}
