import { Link } from '@tanstack/react-router';
import { Check, PackageCheck, ScanBarcode } from 'lucide-react';
import { useState } from 'react';
import { OrdersQuery } from '../api/operations';
import type { OrderDetail, OrdersData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { CountByCode } from '../stock/count-by-code';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { useOrdersLocation } from './location-filter';

const titleOf = (line: OrderDetail['lineItems'][number]) =>
  line.variantTitle && line.variantTitle !== 'Default Title'
    ? `${line.title} · ${line.variantTitle}`
    : line.title;

/**
 * An order packed by scanning (APP-04, ADR-373): each barcode or SKU read ticks off one of its
 * line, an item not in the order or one too many is said at once, and the order is packed when
 * all of it is there. What is counted stays on this phone until packed; nothing is sent before.
 */
export function PackByScan({
  order,
  packing,
  onPack,
  onClose,
}: {
  order: OrderDetail;
  packing: boolean;
  onPack: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [counted, setCounted] = useState<Record<string, number>>({});
  const [over, setOver] = useState<string | null>(null);
  const lines = order.lineItems.filter((line) => line.quantity > 0);
  const left = lines.reduce((sum, line) => sum + line.quantity - (counted[line.id] ?? 0), 0);

  /** One more of the line with this variant; an item the order has none of is not on the list. */
  const oneMore = (_itemId: string, variantId: string) => {
    setOver(null);
    const ofVariant = lines.filter((line) => line.variantId === variantId);
    if (ofVariant.length === 0) return false;
    const open = ofVariant.find((line) => (counted[line.id] ?? 0) < line.quantity);
    if (!open) {
      const all = ofVariant.reduce((sum, line) => sum + line.quantity, 0);
      setOver(t('pack.tooMany', { count: formatCount(all), title: titleOf(ofVariant[0]!) }));
      return true;
    }
    setCounted((now) => ({ ...now, [open.id]: (now[open.id] ?? 0) + 1 }));
    return true;
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="font-semibold">{t('pack.title')}</h2>
      <CountByCode
        locationId={order.location.id}
        onItem={oneMore}
        notOnList={(code) => t('pack.notInOrder', { code })}
      />
      {over && <Alert tone="danger">{over}</Alert>}
      <ul className="flex flex-col divide-y divide-line">
        {lines.map((line) => {
          const done = (counted[line.id] ?? 0) >= line.quantity;
          return (
            <li key={line.id} className="flex items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                {done && <Check aria-hidden className="size-5 shrink-0 text-success" />}
                <span dir="auto">{titleOf(line)}</span>
              </span>
              <span className={done ? 'font-medium text-success' : 'text-secondary'}>
                {t('pack.counted', {
                  counted: formatCount(counted[line.id] ?? 0),
                  count: formatCount(line.quantity),
                })}
              </span>
            </li>
          );
        })}
      </ul>
      {left > 0 ? (
        <p className="text-secondary">{t('pack.left', { count: formatCount(left) })}</p>
      ) : (
        <Alert tone="success">{t('pack.allHere')}</Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          icon={<PackageCheck aria-hidden className="size-5" />}
          disabled={left > 0}
          busy={packing}
          onClick={onPack}
        >
          {t('pack.done')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('pack.stop')}
        </Button>
      </div>
    </Card>
  );
}

/**
 * After an order is packed by scanning, the next one to pack (ADR-374): the oldest waiting at
 * the location the orders list shows, opened to scan; or word that none is left.
 */
export function NextToPack({ after }: { after: string }) {
  const { t } = useLocale();
  const shop = useShop();
  const where = useOrdersLocation(undefined);
  const query = [where.location && `location_id:${where.location}`].filter(Boolean).join(' ');
  const next = useAdminQuery<OrdersData>(
    ['nextToPack', after, where.location ?? null],
    OrdersQuery,
    {
      first: 2,
      after: null,
      query: query || null,
      stage: 'TO_PACK',
      locationId: where.location ?? null,
    },
    { enabled: where.ready },
  );
  if (!where.ready || next.isPending) return <Loading label={t('state.loading')} />;
  if (next.isError) return <ErrorState message={errorText(next.error, t)} />;
  const order = next.data.orders.nodes.find((each) => each.id !== after);
  return (
    <Card className="flex flex-col gap-3 p-4">
      {order ? (
        <Link
          to="/$shopId/orders/$orderId"
          params={{ shopId: shop.id, orderId: order.id }}
          search={{ scan: true }}
          className="inline-flex min-h-12 items-center gap-2 self-start rounded-control bg-primary px-4 font-medium text-on-primary md:min-h-10"
        >
          <ScanBarcode aria-hidden className="size-5" />
          {t('pack.next', { name: order.name })}
        </Link>
      ) : (
        <>
          <Alert tone="success">{t('pack.noneLeft')}</Alert>
          <Link
            to="/$shopId/orders"
            params={{ shopId: shop.id }}
            search={{ stage: 'TO_PACK' }}
            className="self-start font-medium text-primary hover:underline"
          >
            {t('pack.toList')}
          </Link>
        </>
      )}
    </Card>
  );
}
