import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  PosCashMoveMutation,
  PosSaleReturnMutation,
  PosSalesQuery,
  PosSessionCloseMutation,
  PosSessionQuery,
} from '../api/operations';
import type {
  PosSaleReturnData,
  PosSalesData,
  PosSaleValue,
  PosSessionData,
  PosSessionPayloadData,
  PosSessionValue,
  PosTenderMethod,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { CheckField, SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { MyPin } from './cashier';
import { METHOD_LABELS, METHODS } from './till';

/** The Z report's figures: what was sold, how it was paid, and what the drawer should hold. */
function ZReport({ session }: { session: PosSessionValue }) {
  const { t } = useLocale();
  const rows: [string, string][] = [
    [t('pos.z.float'), formatMoney(session.openingFloat.amount)],
    [t('pos.z.sales', { count: session.salesCount }), formatMoney(session.gross.amount)],
    [t('pos.discount'), `-${formatMoney(session.discounts.amount)}`],
    [
      t('pos.z.returns', { count: session.returnsCount }),
      `-${formatMoney(session.returned.amount)}`,
    ],
    [t('pos.taxIncluded'), formatMoney(session.tax.amount)],
    ...session.tenders.map(
      (tender) =>
        [t(METHOD_LABELS[tender.method]), formatMoney(tender.amount.amount)] as [string, string],
    ),
    [t('pos.z.orders', { count: session.ordersPaidCount }), formatMoney(session.ordersPaid.amount)],
    [t('pos.z.cashIn'), formatMoney(session.cashIn.amount)],
    [t('pos.z.cashOut'), `-${formatMoney(session.cashOut.amount)}`],
    [t('pos.z.expected'), formatMoney(session.expectedCash.amount)],
  ];
  if (session.countedCash) rows.push([t('pos.z.counted'), formatMoney(session.countedCash.amount)]);
  const difference = session.difference ? Number(session.difference.amount) : null;
  return (
    <div className="flex flex-col gap-2">
      <dl className="num flex flex-col gap-1">
        {[
          ...rows,
          ...session.cashiers.map(
            (cashier) =>
              [
                t('pos.z.cashier', {
                  name: cashier.name ?? t('pos.z.noCashier'),
                  count: cashier.salesCount,
                }),
                formatMoney(cashier.total.amount),
              ] as [string, string],
          ),
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {difference !== null && (
        <Alert tone={difference === 0 ? 'success' : 'warning'}>
          {difference === 0
            ? t('pos.z.balanced')
            : difference < 0
              ? t('pos.z.short', { amount: formatMoney(String(-difference)) })
              : t('pos.z.over', { amount: formatMoney(String(difference)) })}
        </Alert>
      )}
    </div>
  );
}

/** Cash put into the drawer or taken out of it, with why. */
function CashMove({ sessionId }: { sessionId: string }) {
  const { t } = useLocale();
  const move = useAdminMutation<
    PosSessionPayloadData,
    { sessionId: string; out: boolean; amount: string; note: string }
  >(PosCashMoveMutation);
  const [out, setOut] = useState<'in' | 'out'>('out');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { posCashMove } = await move.mutateAsync({
        sessionId,
        out: out === 'out',
        amount,
        note,
      });
      const error = posCashMove?.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else {
        setAmount('');
        setNote('');
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <h3 className="font-semibold">{t('pos.cashMove')}</h3>
      <SelectField
        label={t('pos.cashMoveKind')}
        value={out}
        options={[
          { value: 'out', label: t('pos.cashOut') },
          { value: 'in', label: t('pos.cashIn') },
        ]}
        onChange={setOut}
      />
      <TextField
        label={t('pos.amount')}
        inputMode="decimal"
        ltr
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
      />
      <TextField
        label={t('pos.cashMoveNote')}
        hint={t('pos.cashMoveNoteHint')}
        maxLength={200}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button
        type="submit"
        variant="secondary"
        className="self-start"
        busy={move.isPending}
        disabled={!amount.trim() || !note.trim()}
      >
        {t('pos.cashMoveSave')}
      </Button>
    </form>
  );
}

/** Units of a sale brought back: how many of each line, how they are paid back, and restocked. */
function ReturnForm({
  sale,
  sessionId,
  onDone,
}: {
  sale: PosSaleValue;
  sessionId: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const give = useAdminMutation<PosSaleReturnData, { input: Record<string, unknown> }>(
    PosSaleReturnMutation,
  );
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<PosTenderMethod>('CASH');
  const [restock, setRestock] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const asked = sale.lines
    .map((line) => ({ lineId: line.id, quantity: Number(counts[line.id] ?? 0) }))
    .filter((line) => Number.isInteger(line.quantity) && line.quantity > 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { posSaleReturn } = await give.mutateAsync({
        input: { saleId: sale.id, sessionId, lines: asked, restock, method },
      });
      const error = posSaleReturn.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else onDone();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3 pt-2">
      {sale.lines.map((line) => {
        const left = line.quantity - line.returnedQuantity;
        return (
          <TextField
            key={line.id}
            label={t('pos.returnHowMany', { title: line.title, left })}
            inputMode="numeric"
            ltr
            disabled={left === 0}
            value={counts[line.id] ?? ''}
            onChange={(event) => setCounts({ ...counts, [line.id]: event.target.value })}
          />
        );
      })}
      <SelectField
        label={t('pos.paidBackBy')}
        value={method}
        options={METHODS.map((each) => ({ value: each, label: t(METHOD_LABELS[each]) }))}
        onChange={setMethod}
      />
      <CheckField label={t('pos.restock')} checked={restock} onChange={setRestock} />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={give.isPending}
        disabled={asked.length === 0}
      >
        {t('pos.giveBack')}
      </Button>
    </form>
  );
}

/** The session's sales, the latest first, each to take a return of. */
function SessionSales({ sessionId }: { sessionId: string }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const sales = useAdminQuery<PosSalesData>(['posSales', sessionId], PosSalesQuery, { sessionId });
  const [returning, setReturning] = useState<string | null>(null);
  if (sales.isPending) return <Loading label={t('state.loading')} />;
  if (sales.isError) return <Alert tone="danger">{errorText(sales.error, t)}</Alert>;
  const nodes = sales.data.posSales.nodes;
  if (nodes.length === 0) return <p className="text-secondary">{t('pos.noSales')}</p>;
  return (
    <ul aria-label={t('pos.sales')} className="flex flex-col divide-y divide-line">
      {nodes.map((sale) => (
        <li key={sale.id} className="flex flex-col gap-1 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{sale.name}</span>
            <span className="num">{formatMoney(sale.total.amount)}</span>
          </div>
          <span className="text-secondary">
            {formatDateTime(sale.soldAt, timezone, locale)}
            {Number(sale.returned.amount) > 0 &&
              ` · ${t('pos.returnedAmount', { amount: formatMoney(sale.returned.amount) })}`}
          </span>
          {returning === sale.id ? (
            <ReturnForm sale={sale} sessionId={sessionId} onDone={() => setReturning(null)} />
          ) : (
            <Button
              variant="tertiary"
              className="self-start"
              aria-label={t('pos.returnOf', { name: sale.name })}
              onClick={() => setReturning(sale.id)}
            >
              {t('pos.return')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The register's open session (POS-07, ADR-872): its Z report as it stands, cash put in or taken
 * out, its sales to take returns of, and closing it with the drawer counted.
 */
export function SessionPanel({ sessionId, onClosed }: { sessionId: string; onClosed: () => void }) {
  const { t } = useLocale();
  const session = useAdminQuery<PosSessionData>(['posSession', sessionId], PosSessionQuery, {
    id: sessionId,
  });
  const close = useAdminMutation<
    PosSessionPayloadData,
    { sessionId: string; countedCash: string; note: string | null }
  >(PosSessionCloseMutation);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [closed, setClosed] = useState<PosSessionValue | null>(null);

  if (session.isPending) return <Loading label={t('state.loading')} />;
  if (session.isError || !session.data.posSession) {
    return (
      <ErrorState
        message={session.isError ? errorText(session.error, t) : t('pos.noSession')}
        action={<Button onClick={() => void session.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  if (closed) {
    return (
      <Card className="mx-auto flex w-full max-w-md flex-col gap-3 p-4">
        <h2 className="text-[length:var(--hatti-type-title-size)] font-semibold">
          {t('pos.closedTitle')}
        </h2>
        <ZReport session={closed} />
        <Button className="self-start" onClick={onClosed}>
          {t('pos.done')}
        </Button>
      </Card>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { posSessionClose } = await close.mutateAsync({
        sessionId,
        countedCash: counted,
        note: note.trim() || null,
      });
      const error = posSessionClose?.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else if (posSessionClose?.session) setClosed(posSessionClose.session);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-[length:var(--hatti-type-title-size)] font-semibold">
          {t('pos.zTitle')}
        </h2>
        <ZReport session={session.data.posSession} />
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <h3 className="font-semibold">{t('pos.close')}</h3>
          <TextField
            label={t('pos.countedCash')}
            hint={t('pos.countedCashHint')}
            inputMode="decimal"
            ltr
            value={counted}
            onChange={(event) => setCounted(event.target.value)}
          />
          <TextField
            label={t('pos.closingNote')}
            maxLength={200}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          {problem && <Alert tone="danger">{problem}</Alert>}
          <Button
            type="submit"
            variant="destructive"
            className="self-start"
            busy={close.isPending}
            disabled={!counted.trim()}
          >
            {t('pos.closeRegister')}
          </Button>
        </form>
      </Card>
      <div className="flex flex-col gap-4">
        <Card className="p-4">
          <CashMove sessionId={sessionId} />
        </Card>
        <MyPin />
        <Card className="flex flex-col gap-2 p-4">
          <h2 className="text-[length:var(--hatti-type-title-size)] font-semibold">
            {t('pos.sales')}
          </h2>
          <SessionSales sessionId={sessionId} />
        </Card>
      </div>
    </div>
  );
}
