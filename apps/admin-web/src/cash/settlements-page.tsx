import { Link, useNavigate } from '@tanstack/react-router';
import { CreditCard, FileUp } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { PaymentSettlementImportMutation, PaymentSettlementsQuery } from '../api/operations';
import type {
  PaymentSettlementAccountValue,
  PaymentSettlementImportData,
  PaymentSettlementOutcome,
  PaymentSettlementOutcomeCounts,
  PaymentSettlementSummary,
  PaymentSettlementsData,
} from '../api/types';
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
import { statementOf } from './cash-page';

/** Each outcome a settlement's import counts, under its name in the API's enum. */
export const SETTLEMENT_OUTCOMES: readonly [
  keyof PaymentSettlementOutcomeCounts,
  PaymentSettlementOutcome,
][] = [
  ['matched', 'MATCHED'],
  ['differs', 'DIFFERS'],
  ['unmatched', 'UNMATCHED'],
  ['repeated', 'REPEATED'],
  ['refund', 'REFUND'],
];

/** An account as staff tell it apart: its gateway's name, and whether it is the sandbox. */
export function accountLabel(
  account: Pick<PaymentSettlementAccountValue, 'gatewayName' | 'sandbox'>,
  t: Translate,
): string {
  return account.sandbox
    ? t('settlements.sandbox', { name: account.gatewayName })
    : account.gatewayName;
}

function Settlements({ settlements }: { settlements: PaymentSettlementSummary[] }) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  return (
    <FormSection title={t('settlements.list')}>
      {settlements.length === 0 ? (
        <p className="text-secondary">{t('settlements.none')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {settlements.map((settlement) => (
            <li key={settlement.id}>
              <Link
                to="/$shopId/settlements/$settlementId"
                params={{ shopId, settlementId: settlement.id }}
                className="flex flex-wrap items-baseline gap-x-3 py-2 hover:bg-canvas"
              >
                <span className="min-w-0 flex-1 font-medium" dir="auto">
                  {settlement.gatewayName}
                  {settlement.reference && (
                    <span className="text-secondary font-normal"> · {settlement.reference}</span>
                  )}
                </span>
                <span className="num font-medium">{formatMoney(settlement.net.amount)}</span>
                <span className="basis-full text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {formatDate(settlement.createdAt, timezone, locale)} ·{' '}
                  {t('settlements.deducted', {
                    fees: formatMoney(settlement.fees.amount),
                    tax: formatMoney(settlement.tax.amount),
                  })}{' '}
                  ·{' '}
                  {settlement.issueCount > 0 ? (
                    <span className="text-danger">
                      {t('cash.issues', { count: settlement.issueCount })}
                    </span>
                  ) : (
                    t('cash.allMatched', { count: settlement.lineCount })
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

type Import = PaymentSettlementImportData['paymentSettlementImport'];

/**
 * A gateway's settlement statement imported (ADR-491): read first, writing nothing, to say what
 * would become of its lines; imported once that reads right, and opened.
 */
function ImportSettlement({ accounts }: { accounts: PaymentSettlementAccountValue[] }) {
  const { t } = useLocale();
  const shopId = useShop().id;
  const navigate = useNavigate();
  const accountField = useId();
  const input = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [checked, setChecked] = useState<Import | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const send = useAdminMutation<PaymentSettlementImportData, Record<string, unknown>>(
    PaymentSettlementImportMutation,
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
    if (!file || !accountId) return;
    setProblems([]);
    try {
      const result = (
        await send.mutateAsync({
          accountId,
          reference: reference.trim() || null,
          dryRun,
          ...(await statementOf(file)),
        })
      ).paymentSettlementImport;
      if (result.userErrors.length > 0) {
        setChecked(null);
        setProblems(result.userErrors.map((error) => problemText(error, t)));
        return;
      }
      if (dryRun) {
        setChecked(result);
        return;
      }
      if (result.settlement) {
        await navigate({
          to: '/$shopId/settlements/$settlementId',
          params: { shopId, settlementId: result.settlement.id },
        });
      }
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const toLookInto = checked
    ? checked.outcomes.differs + checked.outcomes.unmatched + checked.outcomes.repeated
    : 0;

  return (
    <FormSection title={t('settlements.import')} hint={t('settlements.import.hint')}>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={accountField} className="font-medium">
            {t('settlements.import.account')}
          </label>
          <select
            id={accountField}
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              reset();
            }}
            className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account, t)}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label={t('settlements.import.reference')}
          hint={t('settlements.import.referenceHint')}
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
          <Alert tone={toLookInto + checked.rowErrorCount > 0 ? 'warning' : 'info'}>
            {t('settlements.import.would', {
              count: checked.rows,
              net: formatMoney(checked.net.amount),
              fees: formatMoney(checked.fees.amount),
              tax: formatMoney(checked.tax.amount),
            })}
          </Alert>
          <ul className="flex flex-col divide-y divide-line">
            {SETTLEMENT_OUTCOMES.filter(([key]) => checked.outcomes[key] > 0).map(
              ([key, outcome]) => (
                <li key={key} className="flex items-baseline gap-3 py-1">
                  <span className="min-w-0 flex-1">
                    {t(`settlements.outcome.${outcome}` as MessageKey)}
                  </span>
                  <span className="num">{formatCount(checked.outcomes[key])}</span>
                </li>
              ),
            )}
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
 * Gateways' settlements (PAY-07, ADR-491): what each gateway paid over for the shop's payments
 * online, less its fees and the tax it withheld; those with lines to look into marked; and a
 * statement imported, checked before it is. Owners, managers and accountants.
 */
export function SettlementsPage() {
  const { t } = useLocale();
  const shopId = useShop().id;
  const query = useAdminQuery<PaymentSettlementsData>(
    ['paymentSettlements'],
    PaymentSettlementsQuery,
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { paymentSettlementAccounts: accounts, paymentSettlements: settlements } = query.data;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/cash"
        params={{ shopId }}
        className="inline-flex min-h-10 items-center self-start text-secondary hover:text-text"
      >
        {t('cash.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settlements.title')}
      </h1>
      {accounts.length === 0 && settlements.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CreditCard aria-hidden className="size-8 text-secondary" />}
            title={t('settlements.noAccounts')}
          />
        </Card>
      ) : (
        <>
          {accounts.length > 0 && <ImportSettlement accounts={accounts} />}
          <Settlements settlements={settlements} />
        </>
      )}
    </div>
  );
}
