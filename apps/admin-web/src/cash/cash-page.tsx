import { Link, useNavigate } from '@tanstack/react-router';
import { FileUp, Wallet } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { CashQuery, CashStatementImportMutation } from '../api/operations';
import type {
  CashData,
  CashStatementImportData,
  CodReceivableAgeValue,
  CodRemittanceOutcome,
  CodRemittanceOutcomeCounts,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** The roles that reconcile what couriers owe, as the core allows (ADR-066, ADR-067). */
export const RECONCILES_CASH: readonly StaffRole[] = ['owner', 'manager', 'accountant'];

/** Days from which cash a courier still holds is late: couriers pay over weekly or fortnightly. */
export const LATE_DAYS = 15;

/** An age of cash owed in words: "0 to 7 days", "Over 30 days". */
export function ageLabel(age: Pick<CodReceivableAgeValue, 'fromDays' | 'toDays'>, t: Translate) {
  return age.toDays === null
    ? t('cash.age.over', { days: age.fromDays - 1 })
    : t('cash.age.range', { from: age.fromDays, to: age.toDays });
}

/** Each outcome the import counts, under its name in the API's enum. */
export const OUTCOMES: readonly [keyof CodRemittanceOutcomeCounts, CodRemittanceOutcome][] = [
  ['received', 'RECEIVED'],
  ['short', 'SHORT'],
  ['over', 'OVER'],
  ['compensated', 'COMPENSATED'],
  ['charged', 'CHARGED'],
  ['notOwed', 'NOT_OWED'],
  ['repeated', 'REPEATED'],
  ['unmatched', 'UNMATCHED'],
];

/** A statement as the core takes it: a CSV as text, an Excel workbook in base64. */
export async function statementOf(file: File): Promise<{ csv: string } | { xlsx: string }> {
  if (/\.xlsx$/i.test(file.name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return { xlsx: btoa(binary) };
  }
  return { csv: await file.text() };
}

function Figure({ label, amount, hint }: { label: string; amount: string; hint: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-secondary">{label}</span>
      <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">
        {formatMoney(amount)}
      </span>
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">{hint}</span>
    </Card>
  );
}

function Ages({ ages }: { ages: CodReceivableAgeValue[] }) {
  const { t } = useLocale();
  return (
    <FormSection title={t('cash.ages')} hint={t('cash.ages.hint')}>
      <ul className="flex flex-col divide-y divide-line">
        {ages.map((age) => {
          const late = age.fromDays >= LATE_DAYS && age.count > 0;
          return (
            <li key={age.fromDays} className="flex items-baseline gap-3 py-2">
              <span className={`min-w-0 flex-1 ${late ? 'font-semibold text-danger' : ''}`}>
                {ageLabel(age, t)}
              </span>
              <span className="text-secondary">{t('cash.parcels', { count: age.count })}</span>
              <span className={`num font-medium ${late ? 'text-danger' : ''}`}>
                {formatMoney(age.amount.amount)}
              </span>
            </li>
          );
        })}
      </ul>
    </FormSection>
  );
}

function Couriers({ couriers }: { couriers: CashData['codReceivables']['couriers'] }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  return (
    <FormSection title={t('cash.couriers')}>
      {couriers.length === 0 ? (
        <p className="text-secondary">{t('cash.couriers.none')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {couriers.map((each) => {
            const late = each.ages.some((age) => age.fromDays >= LATE_DAYS && age.count > 0);
            return (
              <li key={each.courier ?? ''} className="flex flex-wrap items-baseline gap-x-3 py-2">
                <span className="min-w-0 flex-1 font-medium" dir="auto">
                  {each.courier ?? t('cod.health.noCourier')}
                </span>
                <span className="num font-medium">{formatMoney(each.owed.amount.amount)}</span>
                <span
                  className={`basis-full text-[length:var(--hatti-type-body-sm-size)] ${
                    late ? 'text-danger' : 'text-secondary'
                  }`}
                >
                  {t('cash.since', {
                    count: each.owed.count,
                    date: formatDate(each.oldestDeliveredAt, timezone, locale),
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </FormSection>
  );
}

function Statements({ statements }: { statements: CashData['codRemittances']['nodes'] }) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  return (
    <FormSection title={t('cash.statements')}>
      {statements.length === 0 ? (
        <p className="text-secondary">{t('cash.statements.none')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {statements.map((statement) => (
            <li key={statement.id}>
              <Link
                to="/$shopId/cash/$remittanceId"
                params={{ shopId, remittanceId: statement.id }}
                className="flex flex-wrap items-baseline gap-x-3 py-2 hover:bg-canvas"
              >
                <span className="min-w-0 flex-1 font-medium" dir="auto">
                  {statement.courier}
                  {statement.reference && (
                    <span className="text-secondary font-normal"> · {statement.reference}</span>
                  )}
                </span>
                <span className="num font-medium">{formatMoney(statement.paid.amount)}</span>
                <span className="basis-full text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {formatDate(statement.createdAt, timezone, locale)} ·{' '}
                  {statement.issueCount > 0 ? (
                    <span className="text-danger">
                      {t('cash.issues', { count: statement.issueCount })}
                    </span>
                  ) : (
                    t('cash.allMatched', { count: statement.lineCount })
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </FormSection>
  );
}

type Import = CashStatementImportData['codRemittanceImport'];

/**
 * A courier's statement imported (ADR-067, ADR-246): read first, writing nothing, to say what
 * would happen to its lines; imported once that reads right, and opened.
 */
function ImportStatement({ couriers }: { couriers: string[] }) {
  const { t } = useLocale();
  const shopId = useShop().id;
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [courier, setCourier] = useState('');
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [checked, setChecked] = useState<Import | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const send = useAdminMutation<CashStatementImportData, Record<string, unknown>>(
    CashStatementImportMutation,
  );

  const reset = () => {
    setChecked(null);
    setProblems([]);
  };

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
    event.target.value = '';
    reset();
  };

  const run = async (dryRun: boolean) => {
    if (!file) return;
    if (!courier.trim()) {
      setProblems([t('cash.import.courierMissing')]);
      return;
    }
    setProblems([]);
    try {
      const result = (
        await send.mutateAsync({
          courier: courier.trim(),
          reference: reference.trim() || null,
          dryRun,
          ...(await statementOf(file)),
        })
      ).codRemittanceImport;
      if (result.userErrors.length > 0) {
        setChecked(null);
        setProblems(result.userErrors.map((error) => problemText(error, t)));
        return;
      }
      if (dryRun) {
        setChecked(result);
        return;
      }
      if (result.remittance) {
        await navigate({
          to: '/$shopId/cash/$remittanceId',
          params: { shopId, remittanceId: result.remittance.id },
        });
      }
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <FormSection title={t('cash.import')} hint={t('cash.import.hint')}>
      <div className="grid gap-3 md:grid-cols-2">
        <TextField
          label={t('cash.import.courier')}
          value={courier}
          list="cash-couriers"
          autoComplete="off"
          onChange={(event) => {
            setCourier(event.target.value);
            reset();
          }}
        />
        <datalist id="cash-couriers">
          {couriers.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <TextField
          label={t('cash.import.reference')}
          hint={t('cash.import.referenceHint')}
          value={reference}
          ltr
          onChange={(event) => {
            setReference(event.target.value);
            reset();
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          icon={<FileUp aria-hidden className="size-5" />}
          disabled={send.isPending}
          onClick={() => input.current?.click()}
        >
          {t(file ? 'cash.import.another' : 'cash.import.choose')}
        </Button>
        {file && (
          <span className="min-w-0 truncate" dir="auto">
            {file.name}
          </span>
        )}
        <input
          ref={input}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          aria-label={t('cash.import.file')}
          onChange={onChosen}
        />
      </div>
      {problems.map((problem) => (
        <Alert key={problem} tone="danger">
          {problem}
        </Alert>
      ))}
      {file && !checked && (
        <Button className="self-start" busy={send.isPending} onClick={() => void run(true)}>
          {t('cash.import.check')}
        </Button>
      )}
      {checked && (
        <div className="flex flex-col gap-3">
          <Alert tone={checked.outcomes.unmatched + checked.rowErrorCount > 0 ? 'warning' : 'info'}>
            {t('cash.import.would', {
              count: checked.rows,
              received: formatMoney(checked.received.amount),
              paid: formatMoney(checked.paid.amount),
            })}
          </Alert>
          <ul className="flex flex-col divide-y divide-line">
            {OUTCOMES.filter(([key]) => checked.outcomes[key] > 0).map(([key, outcome]) => (
              <li key={key} className="flex items-baseline gap-3 py-1">
                <span className="min-w-0 flex-1">{t(`cash.outcome.${outcome}` as MessageKey)}</span>
                <span className="num">{formatCount(checked.outcomes[key])}</span>
              </li>
            ))}
          </ul>
          {checked.rowErrorCount > 0 && (
            <Alert tone="warning">
              <p>{t('cash.import.rowErrors', { count: checked.rowErrorCount })}</p>
              <ul className="mt-1 list-disc ps-5">
                {checked.rowErrors.slice(0, 5).map((error) => (
                  <li key={`${error.row}-${error.column ?? ''}`}>
                    {t('cash.import.row', { row: error.row })}
                    {error.column ? ` (${error.column})` : ''}: {error.message}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          <Button className="self-start" busy={send.isPending} onClick={() => void run(false)}>
            {t('cash.import.confirm')}
          </Button>
        </div>
      )}
    </FormSection>
  );
}

/**
 * The cash couriers hold (COD-10, ADR-066, ADR-067): what they owe on delivered cash-on-delivery
 * orders and what is still on its way; by how long it has been owed, late cash in red; by
 * courier, the one owing most first; their statements, those with lines to look into marked;
 * and a statement imported, checked before it is. Owners, managers and accountants.
 */
export function CashPage() {
  const { t } = useLocale();
  const query = useAdminQuery<CashData>(['cash'], CashQuery);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { codReceivables: cash, codRemittances: statements } = query.data;
  const nothing = cash.owed.count === 0 && cash.onTheWay.count === 0;
  const names = [
    ...new Set([
      ...cash.couriers.flatMap((each) => (each.courier ? [each.courier] : [])),
      ...statements.nodes.map((each) => each.courier),
    ]),
  ];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('cash.title')}
      </h1>
      {nothing ? (
        <Card>
          <EmptyState
            icon={<Wallet aria-hidden className="size-8 text-secondary" />}
            title={t('cash.nothing')}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Figure
              label={t('cash.owed')}
              amount={cash.owed.amount.amount}
              hint={t('cash.owed.hint', { count: cash.owed.count })}
            />
            <Figure
              label={t('cash.onTheWay')}
              amount={cash.onTheWay.amount.amount}
              hint={t('cash.onTheWay.hint', { count: cash.onTheWay.count })}
            />
          </div>
          {cash.owed.count > 0 && <Ages ages={cash.ages} />}
          <Couriers couriers={cash.couriers} />
        </>
      )}
      <ImportStatement couriers={names} />
      <Statements statements={statements.nodes} />
    </div>
  );
}
