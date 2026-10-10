/** A variant's stock history: every change at every location or one, a page at a time (INV-03). */
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { InventoryChangesQuery } from '../api/operations';
import type { InventoryChangesData, StockChange, StockChangePage } from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount, formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useShop, useShopTimezone } from '../shell/shop-context';
import { Alert } from '../ui/feedback';
import { Button } from '../ui/button';

/** The order a change was for, by its ID, where it was an order's. */
export function orderOf(change: Pick<StockChange, 'referenceDocumentUri'>): string | null {
  return /^hatti:\/\/orders\/(ord_[0-9a-z]+)$/.exec(change.referenceDocumentUri ?? '')?.[1] ?? null;
}

/**
 * A variant's stock changes, newest first: the latest as its stock was read, older ones a page at a
 * time as asked, at every location or the one chosen. Each says by how much, which quantity, why,
 * what was left of it, and the order it was for.
 */
export function StockChanges({
  itemId,
  latest,
  locations,
  word,
}: {
  itemId: string;
  /** The latest changes, read with the variant's stock. */
  latest: StockChangePage;
  /** Where the variant is stocked; one to choose among where there are more. */
  locations: readonly { id: string; name: string }[];
  word: (kind: 'reason' | 'name', word: string) => string;
}) {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const timezone = useShopTimezone();
  const [location, setLocation] = useState('');
  const changes = useInfiniteQuery({
    queryKey: ['admin', shop.id, 'inventoryChanges', itemId, location || null],
    queryFn: async ({ pageParam }) =>
      (
        await store.graphql<InventoryChangesData>(shop.id, InventoryChangesQuery, {
          id: itemId,
          after: pageParam,
          locationId: location || null,
        })
      ).inventoryItem?.changes ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? last.pageInfo.endCursor : undefined),
    // Every location's latest came with the variant's stock: the rest only as asked, and all of
    // it read again when the shop's stock changes.
    initialData: location ? undefined : { pages: [latest], pageParams: [null] },
    staleTime: Infinity,
  });
  const shown = changes.data?.pages.flatMap((page) => page.nodes) ?? [];
  if (!location && latest.nodes.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="font-medium">{t('stock.changes')}</h3>
      {locations.length > 1 && (
        <SelectField
          label={t('stock.changesAt')}
          value={location}
          options={[
            { value: '', label: t('stock.everyLocation') },
            ...locations.map((each) => ({ value: each.id, label: each.name })),
          ]}
          onChange={setLocation}
        />
      )}
      {changes.isError && <Alert tone="danger">{errorText(changes.error, t)}</Alert>}
      {changes.isPending ? (
        <p className="text-secondary">{t('state.loading')}</p>
      ) : shown.length === 0 ? (
        <p className="text-secondary">{t('stock.noChanges')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((change, index) => {
            const order = orderOf(change);
            return (
              <li
                key={`${change.createdAt}-${index}`}
                className="flex flex-wrap justify-between gap-x-3 text-[length:var(--hatti-type-body-sm-size)]"
              >
                <span>
                  <span className={`num font-medium ${change.delta < 0 ? 'text-danger' : ''}`}>
                    {change.delta > 0 ? `+${formatCount(change.delta)}` : formatCount(change.delta)}
                  </span>{' '}
                  {word('name', change.name)} · {word('reason', change.reason)} ·{' '}
                  {t('stock.after', { count: formatCount(change.quantityAfterChange) })}
                  {locations.length > 1 && !location && (
                    <>
                      {' · '}
                      <span dir="auto">{change.location.name}</span>
                    </>
                  )}
                  {order && (
                    <>
                      {' · '}
                      <Link
                        to="/$shopId/orders/$orderId"
                        params={{ shopId: shop.id, orderId: order }}
                        className="text-primary underline"
                      >
                        {t('stock.itsOrder')}
                      </Link>
                    </>
                  )}
                </span>
                <span className="text-secondary">
                  {formatDateTime(change.createdAt, timezone, locale)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {changes.hasNextPage && (
        <Button
          variant="tertiary"
          className="self-start"
          busy={changes.isFetchingNextPage}
          onClick={() => void changes.fetchNextPage()}
        >
          {t('stock.olderChanges')}
        </Button>
      )}
    </div>
  );
}
