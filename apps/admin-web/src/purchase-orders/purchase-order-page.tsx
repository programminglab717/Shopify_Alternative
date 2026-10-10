import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Printer, ScanBarcode, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  PurchaseOrderCloseMutation,
  PurchaseOrderDocumentQuery,
  PurchaseOrderQuery,
  PurchaseOrderReceiveMutation,
  PurchaseOrderUpdateMutation,
  StockCountFindQuery,
} from '../api/operations';
import type {
  DocumentLanguage,
  PurchaseOrder,
  PurchaseOrderData,
  PurchaseOrderDocumentData,
  StockCountFindData,
  UserError,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney, formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { parseStock } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Scanner, canScan } from '../stock/scanner';
import { EDITS_STOCK } from '../stock/stock-page';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { openPrintTab } from '../ui/print';
import { AMOUNT, FindVariants, type Line } from './new-purchase-order-page';
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
      {order.lines.some((line) => line.unitCost) && (
        <p className="text-secondary">{t('po.costHint')}</p>
      )}
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

/** An amount as the core gives it, as one would type it: "1450.00" reads "1450". */
const typed = (amount: string) => amount.replace(/\.00$/, '');

/**
 * An open order changed: its supplier's number, day expected and note; each line's quantity, no
 * fewer than came, and cost; lines none of which came removed; goods added.
 */
function EditOrder({ order, onDone }: { order: PurchaseOrder; onDone: () => void }) {
  const { t } = useLocale();
  const update = useAdminMutation<Mutated, { id: string; input: Record<string, unknown> }>(
    PurchaseOrderUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const [reference, setReference] = useState(order.reference ?? '');
  const [expectedOn, setExpectedOn] = useState(order.expectedOn ?? '');
  const [note, setNote] = useState(order.note ?? '');
  const [lines, setLines] = useState(
    order.lines.map((line) => ({
      line,
      quantity: String(line.quantity),
      unitCost: line.unitCost ? typed(line.unitCost.amount) : '',
      removed: false,
    })),
  );
  const [added, setAdded] = useState<Line[]>([]);
  const kept = lines.filter((each) => !each.removed);
  const tooFew = (each: (typeof lines)[number]) => {
    const units = parseStock(each.quantity);
    return units === null || units < Math.max(1, each.line.received);
  };
  const badCost = (cost: string) => cost.trim() !== '' && !AMOUNT.test(cost.trim());
  const valid =
    kept.length + added.length > 0 &&
    kept.every((each) => !tooFew(each) && !badCost(each.unitCost)) &&
    added.every((each) => (parseStock(each.quantity) ?? 0) > 0 && !badCost(each.unitCost));
  const change = (id: string, patch: Partial<(typeof lines)[number]>) =>
    setLines((now) => now.map((each) => (each.line.id === id ? { ...each, ...patch } : each)));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const ok = await attempt(
      async () =>
        Object.values(
          await update.mutateAsync({
            id: order.id,
            input: {
              reference: reference.trim(),
              expectedOn,
              note: note.trim(),
              linesToUpdate: kept
                .filter(
                  (each) =>
                    each.quantity !== String(each.line.quantity) ||
                    each.unitCost !== (each.line.unitCost ? typed(each.line.unitCost.amount) : ''),
                )
                .map((each) => ({
                  lineId: each.line.id,
                  quantity: parseStock(each.quantity),
                  unitCost: each.unitCost.trim(),
                })),
              lineIdsToRemove: lines.filter((each) => each.removed).map((each) => each.line.id),
              linesToAdd: added.map((each) => ({
                inventoryItemId: each.itemId,
                quantity: parseStock(each.quantity),
                unitCost: each.unitCost.trim() || null,
              })),
            },
          }),
        )[0]!,
    );
    if (ok) onDone();
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <h2 className="font-semibold">{t('po.edit')}</h2>
        <div className="flex flex-wrap gap-3">
          <TextField
            label={t('po.reference')}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          <TextField
            label={t('po.expectedOn')}
            type="date"
            ltr
            value={expectedOn}
            onChange={(event) => setExpectedOn(event.target.value)}
          />
        </div>
        <TextField
          label={t('po.note')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <ul className="flex flex-col divide-y divide-line">
          {kept.map((each) => (
            <li key={each.line.id} className="flex flex-wrap items-end gap-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium" dir="auto">
                  {titleOf(each.line)}
                </span>
                {each.line.received > 0 && (
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t('po.cameAlready', { count: formatCount(each.line.received) })}
                  </span>
                )}
              </span>
              <TextField
                label={t('po.quantityOf', { title: titleOf(each.line) })}
                inputMode="numeric"
                ltr
                className="w-24"
                value={each.quantity}
                error={
                  tooFew(each)
                    ? t('po.atLeast', { count: formatCount(Math.max(1, each.line.received)) })
                    : null
                }
                onChange={(event) => change(each.line.id, { quantity: event.target.value })}
              />
              <TextField
                label={t('po.unitCostOf', { title: titleOf(each.line) })}
                inputMode="decimal"
                ltr
                className="w-32"
                value={each.unitCost}
                error={badCost(each.unitCost) ? t('po.badCost') : null}
                onChange={(event) => change(each.line.id, { unitCost: event.target.value })}
              />
              {each.line.received === 0 && (
                <Button
                  variant="tertiary"
                  aria-label={t('po.removeLine', { title: titleOf(each.line) })}
                  icon={<Trash2 aria-hidden className="size-5" />}
                  onClick={() => change(each.line.id, { removed: true })}
                />
              )}
            </li>
          ))}
          {added.map((each, index) => (
            <li key={each.itemId} className="flex flex-wrap items-end gap-3 py-2">
              <span className="min-w-0 flex-1 font-medium" dir="auto">
                {each.title}
              </span>
              <TextField
                label={t('po.quantityOf', { title: each.title })}
                inputMode="numeric"
                ltr
                className="w-24"
                value={each.quantity}
                onChange={(event) =>
                  setAdded((now) =>
                    now.map((line, at) =>
                      at === index ? { ...line, quantity: event.target.value } : line,
                    ),
                  )
                }
              />
              <TextField
                label={t('po.unitCostOf', { title: each.title })}
                inputMode="decimal"
                ltr
                className="w-32"
                value={each.unitCost}
                error={badCost(each.unitCost) ? t('po.badCost') : null}
                onChange={(event) =>
                  setAdded((now) =>
                    now.map((line, at) =>
                      at === index ? { ...line, unitCost: event.target.value } : line,
                    ),
                  )
                }
              />
              <Button
                variant="tertiary"
                aria-label={t('po.removeLine', { title: each.title })}
                icon={<Trash2 aria-hidden className="size-5" />}
                onClick={() => setAdded((now) => now.filter((_, at) => at !== index))}
              />
            </li>
          ))}
        </ul>
        <FindVariants
          chosen={
            new Set([
              ...kept.map((each) => each.line.inventoryItem.id),
              ...added.map((each) => each.itemId),
            ])
          }
          onAdd={(line) => setAdded((now) => [...now, line])}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={update.isPending} disabled={!valid}>
            {t('po.saveChanges')}
          </Button>
          <Button variant="tertiary" onClick={onDone}>
            {t('returns.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

const LANGUAGES: readonly DocumentLanguage[] = ['BILINGUAL', 'ENGLISH', 'URDU'];

/** The order as a page for its supplier, in the language chosen, opened in a tab to print. */
function PrintOrder({ order }: { order: PurchaseOrder }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const shopId = useShop().id;
  const [language, setLanguage] = useState<DocumentLanguage>('BILINGUAL');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const print = async () => {
    setProblem(null);
    // Opened while the tap is still being handled, so that pop-up blockers let it through.
    const tab = openPrintTab();
    if (!tab) {
      setProblem(t('shipping.popupBlocked'));
      return;
    }
    setBusy(true);
    try {
      const { purchaseOrderDocument } = await store.graphql<PurchaseOrderDocumentData>(
        shopId,
        PurchaseOrderDocumentQuery,
        { id: order.id, language },
      );
      if (!purchaseOrderDocument) throw new Error(t('po.gone'));
      tab.show(purchaseOrderDocument.html);
    } catch (failure) {
      tab.close();
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <SelectField<DocumentLanguage>
          label={t('print.language')}
          value={language}
          options={LANGUAGES.map((each) => ({
            value: each,
            label: t(`print.language.${each}` as MessageKey),
          }))}
          onChange={setLanguage}
        />
        <Button
          variant="secondary"
          busy={busy}
          icon={<Printer aria-hidden className="size-5" />}
          onClick={() => void print()}
        >
          {t('po.print')}
        </Button>
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
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
  const [editing, setEditing] = useState(false);
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
  if (editing && edits) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {back}
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">{order.name}</h1>
        <EditOrder order={order} onDone={() => setEditing(false)} />
      </div>
    );
  }

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
          {order.note && (
            <div className="sm:col-span-2">
              <dt className="text-secondary">{t('po.note')}</dt>
              <dd dir="auto" className="whitespace-pre-line">
                {order.note}
              </dd>
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
      <PrintOrder order={order} />
      {edits && <Receive order={order} />}
      {edits && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {t('po.edit')}
          </Button>
          <Close order={order} />
        </div>
      )}
    </div>
  );
}
