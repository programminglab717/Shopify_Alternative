import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, ScanBarcode } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  PurchaseOrderCloseMutation,
  PurchaseOrderQuery,
  PurchaseOrderReceiveMutation,
  StockCountFindQuery,
} from '../api/operations';
import type { PurchaseOrder, PurchaseOrderData, StockCountFindData, UserError } from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney, formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { parseStock } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Scanner, canScan } from '../stock/scanner';
import { EDITS_STOCK } from '../stock/stock-page';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { STATUS_LABELS, useDay } from './purchase-orders-page';

type Mutated = Record<string, { userErrors: UserError[] }>;

const titleOf = (line: PurchaseOrder['lines'][number]) =>
  line.variantTitle && line.variantTitle !== 'Default Title'
    ? `${line.productTitle} · ${line.variantTitle}`
    : line.productTitle;

/**
 * Goods that came, counted against what is still to come of each line: typed, filled with all of
 * it, or scanned one box at a time by barcode or SKU; then received together into stock.
 */
function Receive({ order }: { order: PurchaseOrder }) {
  const { t } = useLocale();
  const shop = useShop();
  const store = useSessionStore();
  const receive = useAdminMutation<Mutated, { id: string; input: Record<string, unknown> }>(
    PurchaseOrderReceiveMutation,
  );
  const { problem, attempt } = useAttempt();
  const [came, setCame] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const open = order.lines.filter((line) => line.received < line.quantity);
  const left = (line: PurchaseOrder['lines'][number]) => line.quantity - line.received;
  const counts = open.map((line) => ({ line, units: parseStock(came[line.id] ?? '') ?? 0 }));
  const total = counts.reduce((sum, each) => sum + each.units, 0);
  const tooMany = counts.some(({ line, units }) => units > left(line));
  const bad = open.some(
    (line) => (came[line.id] ?? '').trim() && parseStock(came[line.id]!) === null,
  );

  /** One more of the line whose variant has `wanted` as its barcode or SKU. */
  const scanned = async (wanted: string) => {
    setSaid(null);
    const quoted = `"${wanted.replace(/["\\]/g, '')}"`;
    let itemId: string | null = null;
    try {
      for (const query of [`barcode:${quoted}`, `sku:${quoted}`]) {
        const data = await store.graphql<StockCountFindData>(shop.id, StockCountFindQuery, {
          query,
          locationId: order.location.id,
        });
        const lower = wanted.toLowerCase();
        const variant = data.products.nodes
          .flatMap((product) => product.variants)
          .find(
            (each) => each.barcode?.toLowerCase() === lower || each.sku?.toLowerCase() === lower,
          );
        if (variant) {
          itemId = variant.inventoryItem.id;
          break;
        }
      }
    } catch (error) {
      setSaid(errorText(error, t));
      return;
    }
    const line = open.find((each) => each.inventoryItem.id === itemId);
    if (!line) {
      setSaid(t('po.notOnOrder', { code: wanted }));
      return;
    }
    setCame((now) => ({ ...now, [line.id]: String((parseStock(now[line.id] ?? '') ?? 0) + 1) }));
    setCode('');
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (total === 0 || tooMany || bad) return;
    setDone(null);
    const ok = await attempt(
      async () =>
        Object.values(
          await receive.mutateAsync({
            id: order.id,
            input: {
              lines: counts
                .filter(({ units }) => units > 0)
                .map(({ line, units }) => ({ lineId: line.id, quantity: units })),
            },
          }),
        )[0]!,
    );
    if (ok) {
      setCame({});
      setDone(t('po.receivedDone', { count: formatCount(total), location: order.location.name }));
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="font-semibold">{t('po.receive')}</h2>
      <p className="text-secondary">{t('po.receiveAbout', { location: order.location.name })}</p>
      <div className="flex flex-wrap gap-2">
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) void scanned(code.trim());
          }}
        >
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-label={t('stock.countScan.code')}
            placeholder={t('stock.countScan.code')}
            dir="ltr"
            autoComplete="off"
            className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
          />
          <Button type="submit" variant="secondary" disabled={!code.trim()}>
            {t('stock.countScan.add')}
          </Button>
        </form>
        <Button
          variant="secondary"
          onClick={() =>
            setCame(Object.fromEntries(open.map((line) => [line.id, String(left(line))])))
          }
        >
          {t('po.fillAll')}
        </Button>
      </div>
      {canScan() &&
        (scanning ? (
          <Scanner
            continuous
            onCode={(read) => void scanned(read)}
            onClose={() => setScanning(false)}
          />
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            icon={<ScanBarcode aria-hidden className="size-5" />}
            onClick={() => setScanning(true)}
          >
            {t('stock.scan')}
          </Button>
        ))}
      {said && <Alert tone="danger">{said}</Alert>}
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <ul className="flex flex-col divide-y divide-line">
          {open.map((line) => {
            const units = parseStock(came[line.id] ?? '') ?? 0;
            return (
              <li key={line.id} className="flex flex-wrap items-end gap-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium" dir="auto">
                    {titleOf(line)}
                  </span>
                  <span
                    className={`text-[length:var(--hatti-type-body-sm-size)] ${
                      units > left(line) ? 'text-danger' : 'text-secondary'
                    }`}
                  >
                    {t('po.toCome', { count: formatCount(left(line)) })}
                  </span>
                </span>
                <label className="flex flex-col gap-1">
                  <span className="text-[length:var(--hatti-type-body-sm-size)]">
                    {t('po.cameOf', { title: titleOf(line) })}
                  </span>
                  <input
                    value={came[line.id] ?? ''}
                    inputMode="numeric"
                    dir="ltr"
                    onChange={(event) =>
                      setCame((now) => ({ ...now, [line.id]: event.target.value }))
                    }
                    className="min-h-12 w-24 rounded-control border border-line bg-surface px-3 md:min-h-10"
                  />
                </label>
              </li>
            );
          })}
        </ul>
        {problem && <Alert tone="danger">{problem}</Alert>}
        {done && <Alert tone="success">{done}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={receive.isPending}
          disabled={total === 0 || tooMany || bad}
        >
          {t('po.receiveSubmit', { count: formatCount(total) })}
        </Button>
      </form>
    </Card>
  );
}

/** Closing an open order with what came, once sure. */
function Close({ order }: { order: PurchaseOrder }) {
  const { t } = useLocale();
  const close = useAdminMutation<Mutated, { id: string }>(PurchaseOrderCloseMutation);
  const { problem, attempt } = useAttempt();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button variant="secondary" className="self-start" onClick={() => setAsking(true)}>
        {t('po.close')}
      </Button>
    );
  }
  return (
    <Card className="flex flex-col gap-3 p-4">
      <p>{t('po.closeAsk', { name: order.name })}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          busy={close.isPending}
          onClick={() =>
            void attempt(async () => Object.values(await close.mutateAsync({ id: order.id }))[0]!)
          }
        >
          {t('po.closeConfirm')}
        </Button>
        <Button variant="tertiary" onClick={() => setAsking(false)}>
          {t('po.closeKeep')}
        </Button>
      </div>
    </Card>
  );
}

/** A purchase order: its supplier, where the goods go, and each line, how much came of it. */
export function PurchaseOrderPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  const day = useDay();
  const { purchaseOrderId } = useParams({ from: '/$shopId/purchase-orders/$purchaseOrderId' });
  const query = useAdminQuery<PurchaseOrderData>(
    ['purchaseOrder', purchaseOrderId],
    PurchaseOrderQuery,
    {
      id: purchaseOrderId,
    },
  );
  const back = (
    <Link
      to="/$shopId/purchase-orders"
      params={{ shopId }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('po.title')}
    </Link>
  );
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const order = query.data.purchaseOrder;
  if (!order) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {back}
        <ErrorState message={t('po.gone')} />
      </div>
    );
  }
  const edits = EDITS_STOCK.includes(role) && order.status === 'OPEN';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">{order.name}</h1>
        <span className="rounded-full border border-line px-2 py-0.5 text-[length:var(--hatti-type-body-sm-size)]">
          {t(STATUS_LABELS[order.status])}
        </span>
      </div>
      <Card className="p-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-secondary">{t('po.supplier')}</dt>
            <dd dir="auto">
              {order.supplier.name}
              {order.supplier.phone && (
                <span dir="ltr" className="text-secondary">
                  {' · '}
                  {formatPhone(order.supplier.phone)}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-secondary">{t('po.location')}</dt>
            <dd dir="auto">{order.location.name}</dd>
          </div>
          {order.reference && (
            <div>
              <dt className="text-secondary">{t('po.reference')}</dt>
              <dd dir="auto">{order.reference}</dd>
            </div>
          )}
          {order.expectedOn && (
            <div>
              <dt className="text-secondary">{t('po.expectedOn')}</dt>
              <dd>{day(order.expectedOn)}</dd>
            </div>
          )}
          <div>
            <dt className="text-secondary">{t('po.came')}</dt>
            <dd className="num">
              {t('po.receivedOf', {
                received: formatCount(order.receivedQuantity),
                count: formatCount(order.totalQuantity),
              })}
            </dd>
          </div>
          {order.totalCost && (
            <div>
              <dt className="text-secondary">{t('po.totalCost')}</dt>
              <dd className="num">
                {formatMoney(order.totalCost.amount, order.totalCost.currencyCode)}
              </dd>
            </div>
          )}
        </dl>
      </Card>
      <Card className="p-4">
        <h2 className="mb-2 font-semibold">{t('po.lines')}</h2>
        <ul className="flex flex-col divide-y divide-line">
          {order.lines.map((line) => (
            <li key={line.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium" dir="auto">
                  {titleOf(line)}
                </span>
                {(line.sku || line.unitCost) && (
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {line.sku && <span dir="ltr">{line.sku}</span>}
                    {line.sku && line.unitCost && ' · '}
                    {line.unitCost &&
                      t('po.each', {
                        amount: formatMoney(line.unitCost.amount, line.unitCost.currencyCode),
                      })}
                  </span>
                )}
              </span>
              <span className="num">
                {t('po.receivedOf', {
                  received: formatCount(line.received),
                  count: formatCount(line.quantity),
                })}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {edits && <Receive order={order} />}
      {edits && <Close order={order} />}
    </div>
  );
}
