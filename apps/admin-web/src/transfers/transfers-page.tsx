import { Link } from '@tanstack/react-router';
import { ArrowLeft, Plus } from 'lucide-react';
import { useState } from 'react';
import { InventoryTransfersQuery } from '../api/operations';
import type { InventoryTransferStatus, InventoryTransfersData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { LocationFilter, useOrdersLocation } from '../orders/location-filter';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { EDITS_STOCK } from '../stock/stock-page';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

export const TRANSFER_STATUS_LABELS: Record<InventoryTransferStatus, MessageKey> = {
  IN_TRANSIT: 'transfers.status.IN_TRANSIT',
  RECEIVED: 'transfers.status.RECEIVED',
  CANCELLED: 'transfers.status.CANCELLED',
};

/**
 * Transfers (INV-04, ADR-360): stock sent between the shop's locations, that on its way first,
 * each with how much of it arrived. Every role sees them; those who change stock send and receive.
 */
export function TransfersPage() {
  const { t, locale } = useLocale();
  const { id: shopId, role } = useShop();
  const timezone = useShopTimezone();
  const [status, setStatus] = useState<InventoryTransferStatus>('IN_TRANSIT');
  const [after, setAfter] = useState<string | null>(null);
  // The location chosen on the orders list or the home: what leaves it and comes to it (ADR-365).
  const where = useOrdersLocation(undefined);
  const query = useAdminQuery<InventoryTransfersData>(
    ['inventoryTransfers'],
    InventoryTransfersQuery,
    { status, after, locationId: where.location ?? null },
    { keepPrevious: true, enabled: where.ready },
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
          {t('transfers.title')}
        </h1>
        {EDITS_STOCK.includes(role) && (
          <Link
            to="/$shopId/transfers/new"
            params={{ shopId }}
            className="inline-flex min-h-12 items-center gap-2 rounded-control bg-primary px-4 font-medium text-on-primary md:min-h-10"
          >
            <Plus aria-hidden className="size-5" />
            {t('transfers.new')}
          </Link>
        )}
      </div>
      <LocationFilter
        locations={where.locations}
        location={where.location}
        label={t('transfers.at')}
        onChoose={(locationId) => {
          where.choose(locationId ?? '');
          setAfter(null);
        }}
      />
      <div role="tablist" className="flex gap-2 overflow-x-auto pb-1">
        {(Object.keys(TRANSFER_STATUS_LABELS) as InventoryTransferStatus[]).map((each) => (
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
            {t(TRANSFER_STATUS_LABELS[each])}
          </button>
        ))}
      </div>
      {!where.ready || query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.inventoryTransfers.nodes.length === 0 ? (
        <EmptyState title={t(status === 'IN_TRANSIT' ? 'transfers.noneOnWay' : 'po.none')} />
      ) : (
        <Card>
          <ul className="flex flex-col divide-y divide-line">
            {query.data.inventoryTransfers.nodes.map((transfer) => (
              <li key={transfer.id}>
                <Link
                  to="/$shopId/transfers/$transferId"
                  params={{ shopId, transferId: transfer.id }}
                  className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-canvas"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">
                      {transfer.name} ·{' '}
                      {t('transfers.route', {
                        from: transfer.origin.name,
                        to: transfer.destination.name,
                      })}
                    </span>
                    <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                      {t('transfers.sentOn', {
                        date: formatDate(transfer.createdAt, timezone, locale),
                      })}
                    </span>
                  </span>
                  <span className="num text-secondary">
                    {t('transfers.arrivedOf', {
                      received: formatCount(transfer.receivedQuantity),
                      count: formatCount(transfer.totalQuantity),
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {query.data?.inventoryTransfers.pageInfo.hasNextPage && (
        <Button
          variant="secondary"
          className="self-center"
          onClick={() => setAfter(query.data.inventoryTransfers.pageInfo.endCursor)}
        >
          {t('transfers.older')}
        </Button>
      )}
    </div>
  );
}
