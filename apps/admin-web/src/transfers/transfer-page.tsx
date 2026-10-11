import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Printer } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  InventoryTransferCancelMutation,
  InventoryTransferDocumentQuery,
  InventoryTransferQuery,
  InventoryTransferReceiveMutation,
} from '../api/operations';
import type {
  DocumentLanguage,
  InventoryTransfer,
  InventoryTransferData,
  InventoryTransferDocumentData,
  UserError,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { parseStock } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { CountByCode } from '../stock/count-by-code';
import { EDITS_STOCK } from '../stock/stock-page';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { openPrintTab } from '../ui/print';
import { TRANSFER_STATUS_LABELS } from './transfers-page';

type Mutated = Record<string, { userErrors: UserError[] }>;
type TransferLine = InventoryTransfer['lines'][number];

const titleOf = (line: TransferLine) =>
  line.variantTitle && line.variantTitle !== 'Default Title'
    ? `${line.productTitle} · ${line.variantTitle}`
    : line.productTitle;

/** Stock that arrived, counted against what is still on its way of each line, received together. */
function Receive({ transfer }: { transfer: InventoryTransfer }) {
  const { t } = useLocale();
  const receive = useAdminMutation<Mutated, { id: string; input: Record<string, unknown> }>(
    InventoryTransferReceiveMutation,
  );
  const { problem, attempt } = useAttempt();
  const [came, setCame] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const open = transfer.lines.filter((line) => line.received < line.quantity);
  const left = (line: TransferLine) => line.quantity - line.received;
  const counts = open.map((line) => ({ line, units: parseStock(came[line.id] ?? '') ?? 0 }));
  const total = counts.reduce((sum, each) => sum + each.units, 0);
  const tooMany = counts.some(({ line, units }) => units > left(line));
  const bad = open.some(
    (line) => (came[line.id] ?? '').trim() && parseStock(came[line.id]!) === null,
  );

  /** One more of the line with this item, where the transfer has one (ADR-363). */
  const oneMore = (itemId: string) => {
    const line = open.find((each) => each.inventoryItem.id === itemId);
    if (!line) return false;
    setCame((now) => ({ ...now, [line.id]: String((parseStock(now[line.id] ?? '') ?? 0) + 1) }));
    return true;
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (total === 0 || tooMany || bad) return;
    setDone(null);
    const ok = await attempt(
      async () =>
        Object.values(
          await receive.mutateAsync({
            id: transfer.id,
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
      setDone(
        t('transfers.receivedDone', {
          count: formatCount(total),
          location: transfer.destination.name,
        }),
      );
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="font-semibold">{t('transfers.receive')}</h2>
      <p className="text-secondary">
        {t('transfers.receiveAbout', { location: transfer.destination.name })}
      </p>
      <CountByCode
        locationId={transfer.destination.id}
        onItem={oneMore}
        notOnList={(code) => t('transfers.notOnTransfer', { code })}
      >
        <Button
          variant="secondary"
          onClick={() =>
            setCame(Object.fromEntries(open.map((line) => [line.id, String(left(line))])))
          }
        >
          {t('transfers.allOnWay')}
        </Button>
      </CountByCode>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <ul className="flex flex-col divide-y divide-line">
          {open.map((line) => (
            <li key={line.id} className="flex flex-wrap items-end justify-between gap-3 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium" dir="auto">
                  {titleOf(line)}
                </span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('transfers.onWay', { count: formatCount(left(line)) })}
                </span>
              </span>
              <label className="flex flex-col gap-1">
                <span className="text-[length:var(--hatti-type-body-sm-size)]">
                  {t('transfers.arrivedOfLine', { title: titleOf(line) })}
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
          ))}
        </ul>
        {tooMany && <Alert tone="danger">{t('transfers.tooMany')}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {done && <Alert tone="success">{done}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={receive.isPending}
          disabled={total === 0 || tooMany || bad}
        >
          {t('transfers.receiveSubmit', {
            count: formatCount(total),
            location: transfer.destination.name,
          })}
        </Button>
      </form>
    </Card>
  );
}

const LANGUAGES: readonly DocumentLanguage[] = ['BILINGUAL', 'ENGLISH', 'URDU'];

/** The transfer as a page to go with the stock (ADR-362), in the language chosen, to print. */
function PrintTransfer({ transfer }: { transfer: InventoryTransfer }) {
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
      const { inventoryTransferDocument } = await store.graphql<InventoryTransferDocumentData>(
        shopId,
        InventoryTransferDocumentQuery,
        { id: transfer.id, language },
      );
      if (!inventoryTransferDocument) throw new Error(t('transfers.gone'));
      tab.show(inventoryTransferDocument.html);
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
          {t('transfers.print')}
        </Button>
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/** What has not arrived, back where it left, once asked. */
function Cancel({ transfer }: { transfer: InventoryTransfer }) {
  const { t } = useLocale();
  const cancel = useAdminMutation<Mutated, { id: string }>(InventoryTransferCancelMutation);
  const { problem, attempt } = useAttempt();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button variant="secondary" className="self-start" onClick={() => setAsking(true)}>
        {t('transfers.cancel')}
      </Button>
    );
  }
  return (
    <Card className="flex flex-col gap-3 p-4">
      <p>
        {t('transfers.cancelAsk', {
          name: transfer.name,
          count: formatCount(transfer.totalQuantity - transfer.receivedQuantity),
          location: transfer.origin.name,
        })}
      </p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          busy={cancel.isPending}
          onClick={() =>
            void attempt(
              async () => Object.values(await cancel.mutateAsync({ id: transfer.id }))[0]!,
            )
          }
        >
          {t('transfers.cancelConfirm')}
        </Button>
        <Button variant="tertiary" onClick={() => setAsking(false)}>
          {t('transfers.cancelKeep')}
        </Button>
      </div>
    </Card>
  );
}

/** A transfer: where it left and where it goes, and each line, how much of it arrived. */
export function TransferPage() {
  const { t, locale } = useLocale();
  const { id: shopId, role } = useShop();
  const timezone = useShopTimezone();
  const { transferId } = useParams({ from: '/$shopId/transfers/$transferId' });
  const query = useAdminQuery<InventoryTransferData>(
    ['inventoryTransfer', transferId],
    InventoryTransferQuery,
    { id: transferId },
  );
  const back = (
    <Link
      to="/$shopId/transfers"
      params={{ shopId }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('transfers.title')}
    </Link>
  );
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const transfer = query.data.inventoryTransfer;
  if (!transfer) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {back}
        <ErrorState message={t('transfers.gone')} />
      </div>
    );
  }
  const edits = EDITS_STOCK.includes(role) && transfer.status === 'IN_TRANSIT';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {transfer.name}
        </h1>
        <span className="rounded-full border border-line px-2 py-0.5 text-[length:var(--hatti-type-body-sm-size)]">
          {t(TRANSFER_STATUS_LABELS[transfer.status])}
        </span>
      </div>
      <Card className="p-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-secondary">{t('transfers.from')}</dt>
            <dd dir="auto">{transfer.origin.name}</dd>
          </div>
          <div>
            <dt className="text-secondary">{t('transfers.to')}</dt>
            <dd dir="auto">{transfer.destination.name}</dd>
          </div>
          {transfer.reference && (
            <div>
              <dt className="text-secondary">{t('transfers.reference')}</dt>
              <dd dir="auto">{transfer.reference}</dd>
            </div>
          )}
          <div>
            <dt className="text-secondary">{t('transfers.sent')}</dt>
            <dd>{formatDate(transfer.createdAt, timezone, locale)}</dd>
          </div>
          <div>
            <dt className="text-secondary">{t('transfers.arrived')}</dt>
            <dd className="num">
              {t('transfers.arrivedOf', {
                received: formatCount(transfer.receivedQuantity),
                count: formatCount(transfer.totalQuantity),
              })}
            </dd>
          </div>
        </dl>
      </Card>
      <Card className="p-4">
        <h2 className="mb-2 font-semibold">{t('po.lines')}</h2>
        <ul className="flex flex-col divide-y divide-line">
          {transfer.lines.map((line) => (
            <li key={line.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium" dir="auto">
                  {titleOf(line)}
                </span>
                {line.sku && (
                  <span
                    dir="ltr"
                    className="text-secondary text-[length:var(--hatti-type-body-sm-size)]"
                  >
                    {line.sku}
                  </span>
                )}
              </span>
              <span className="num">
                {t('transfers.arrivedOf', {
                  received: formatCount(line.received),
                  count: formatCount(line.quantity),
                })}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <PrintTransfer transfer={transfer} />
      {edits && <Receive transfer={transfer} />}
      {edits && <Cancel transfer={transfer} />}
    </div>
  );
}
