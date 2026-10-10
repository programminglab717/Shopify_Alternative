/** Orders as they come (ORD-01, COD-04): what the orders list asks again while it is open (ADR-342). */
import { useQuery } from '@tanstack/react-query';
import { ArrowUp } from 'lucide-react';
import { useEffect } from 'react';
import { FreshOrdersQuery } from '../api/operations';
import type { FreshOrdersData, OrderListItem, OrderStage } from '../api/types';
import { useSessionStore } from '../auth/context';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useShop } from '../shell/shop-context';
import { Button } from '../ui/button';

/** How often the orders list, Home and the Confirmation Desk ask again while they are open. */
export const ASK_AGAIN_MS = 30_000;

/** How many of a tab's newest orders the list asks for: more new than these are "20+". */
export const FRESH_MOST = 20;

/** Orders come that a list does not show yet: how many, at most {@link FRESH_MOST}, and whether more. */
export interface Fresh {
  count: number;
  more: boolean;
}

/**
 * The orders among a tab's newest that are newer than the newest its list shows. An order's ID
 * sorts after those of the orders placed before it (UUIDv7's time order, kept by public IDs), and
 * the list is in that order, so those newer are those whose IDs sort after; none shown, all are.
 */
export function freshOf(data: FreshOrdersData | undefined, newest: string | null): Fresh {
  const nodes = data?.orders.nodes ?? [];
  const fresh = newest === null ? nodes : nodes.filter((node) => node.id > newest);
  return {
    count: fresh.length,
    more:
      fresh.length > 0 &&
      fresh.length === nodes.length &&
      Boolean(data?.orders.pageInfo.hasNextPage),
  };
}

/** How many came, as the page's title and the list say it: "3", or "20+". */
export function freshCount(fresh: Fresh): string {
  return `${formatCount(fresh.count)}${fresh.more ? '+' : ''}`;
}

/**
 * The orders come since a list was read: its tab's newest asked for every half minute while it is
 * open, in view or not, and how many are new counted in the page's title, "(3) Hatti". The list's
 * own answer is the first, so a list read is not asked again at once. `read` is null until the
 * list is read.
 */
export function useFreshOrders(
  list: { stage: OrderStage | null; query: string | null },
  read: { shown: readonly OrderListItem[]; more: boolean; at: number } | null,
): Fresh & { askedAt: number } {
  const store = useSessionStore();
  const shop = useShop();
  const newest = read?.shown[0]?.id ?? null;
  const asked = useQuery({
    // A list read again with orders newer than before starts again from its own answer.
    queryKey: [
      'admin',
      shop.id,
      'freshOrders',
      list.stage,
      list.query,
      read ? (newest ?? 'none') : 'reading',
    ],
    queryFn: () =>
      store.graphql<FreshOrdersData>(shop.id, FreshOrdersQuery, {
        first: FRESH_MOST,
        query: list.query,
        stage: list.stage,
      }),
    enabled: read !== null,
    initialData: read
      ? {
          orders: {
            nodes: read.shown.slice(0, FRESH_MOST).map(({ id }) => ({ id })),
            pageInfo: { hasNextPage: read.shown.length > FRESH_MOST || read.more },
          },
        }
      : undefined,
    initialDataUpdatedAt: read?.at,
    staleTime: ASK_AGAIN_MS,
    refetchInterval: ASK_AGAIN_MS,
    refetchIntervalInBackground: true,
  });
  const fresh = freshOf(asked.data, newest);
  const title = fresh.count > 0 ? freshCount(fresh) : null;

  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = `(${title}) ${before}`;
    return () => {
      document.title = before;
    };
  }, [title]);

  return { ...fresh, askedAt: asked.dataUpdatedAt };
}

/**
 * Orders come since the list was read, said above it and shown at a tap, never moved in under
 * one's thumb; said to screen readers as they come.
 */
export function FreshOrdersNotice({
  fresh,
  busy,
  onShow,
}: {
  fresh: Fresh;
  busy: boolean;
  onShow: () => void;
}) {
  const { t } = useLocale();
  const count = freshCount(fresh);
  return (
    <>
      <p role="status" className="sr-only">
        {fresh.count > 0 ? t('orders.freshSaid', { count }) : ''}
      </p>
      {fresh.count > 0 && (
        <Button
          busy={busy}
          icon={<ArrowUp aria-hidden className="size-5" />}
          onClick={onShow}
          className="self-center rounded-full shadow-md"
        >
          {t('orders.fresh', { count })}
        </Button>
      )}
    </>
  );
}
