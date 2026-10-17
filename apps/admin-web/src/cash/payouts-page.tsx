import { Link } from '@tanstack/react-router';
import { Download, Landmark } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PayoutsReportQuery } from '../api/operations';
import type { PayoutsReportData, PayoutWithholdingValue } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney, formatMonth } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/** The periods the report is read for: calendar months, and Pakistan's tax year, July to June. */
export const PAYOUT_PERIODS = ['thisMonth', 'lastMonth', 'thisTaxYear', 'lastTaxYear'] as const;
export type PayoutPeriod = (typeof PAYOUT_PERIODS)[number];

/** The offset of the time zone `timeZone` from UTC at `at`: "+05:00", or "Z". */
function offsetAt(timeZone: string, at: Date): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')
      ?.value.replace('GMT', '') || 'Z'
  );
}

/** Midnight on the first of month `month` (1 to 12, or past either end) of `year`, in `timeZone`. */
export function startOfMonth(timeZone: string, year: number, month: number): Date {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  const local = `${y}-${String(m).padStart(2, '0')}-01T00:00:00`;
  return new Date(`${local}${offsetAt(timeZone, new Date(`${local}Z`))}`);
}

/** Where period `period` starts and ends, in the shop's time zone, as of `now`. */
export function payoutPeriod(
  period: PayoutPeriod,
  timeZone: string,
  now = new Date(),
): { from: string; before: string } {
  const [year, month] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number) as [number, number];
  // The tax year starts on 1 July.
  const taxYear = month >= 7 ? year : year - 1;
  const starts: Record<PayoutPeriod, [number, number, number]> = {
    thisMonth: [year, month, 1],
    lastMonth: [year, month - 1, 1],
    thisTaxYear: [taxYear, 7, 12],
    lastTaxYear: [taxYear - 1, 7, 12],
  };
  const [startYear, startMonth, months] = starts[period];
  return {
    from: startOfMonth(timeZone, startYear, startMonth).toISOString(),
    before: startOfMonth(timeZone, startYear, startMonth + months).toISOString(),
  };
}

/** A field of a CSV file, quoted where it must be. */
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The statements that withheld tax as a CSV file, for the shop's accountant and its return: a
 * line each, its date in the shop's time zone, who paid, the reference, and the amounts.
 */
export function withholdingsCsv(
  rows: PayoutWithholdingValue[],
  timeZone: string,
  t: Translate,
): string {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const header = [
    t('payouts.csv.date'),
    t('payouts.csv.paidBy'),
    t('payouts.csv.kind'),
    t('payouts.csv.reference'),
    t('settlements.gross'),
    t('settlements.fees'),
    t('cash.statement.tax'),
    t('cash.statement.paid'),
  ];
  const lines = rows.map((row) => [
    day.format(new Date(row.importedAt)),
    row.name,
    t(`payouts.kind.${row.kind}` as MessageKey),
    row.reference ?? '',
    row.gross.amount,
    row.fees.amount,
    row.tax.amount,
    row.net.amount,
  ]);
  return [header, ...lines].map((line) => line.map(field).join(',')).join('\r\n') + '\r\n';
}

function Figure({ label, amount }: { label: string; amount: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-secondary">{label}</span>
      <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">
        {formatMoney(amount)}
      </span>
    </Card>
  );
}

/**
 * Payouts and tax withheld (ANL-09, TAX-03, ADR-493): what gateways and couriers paid the shop
 * in a month or a tax year, less their fees and the tax they withheld; by who paid and by month;
 * and the statements that withheld tax, to download for the shop's return. Owners, managers and
 * accountants.
 */
export function PayoutsPage() {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  const [period, setPeriod] = useState<PayoutPeriod>('thisMonth');
  const range = useMemo(() => payoutPeriod(period, timezone), [period, timezone]);
  const query = useAdminQuery<PayoutsReportData>(
    ['payoutsReport', range.from, range.before],
    PayoutsReportQuery,
    range,
  );

  const download = (rows: PayoutWithholdingValue[]) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(
      new Blob([withholdingsCsv(rows, timezone, t)], { type: 'text/csv' }),
    );
    link.download = `tax-withheld-${range.from.slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const report = query.data?.payoutsReport;
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
        {t('payouts.title')}
      </h1>
      <div role="tablist" className="flex flex-wrap gap-2">
        {PAYOUT_PERIODS.map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={period === each}
            onClick={() => setPeriod(each)}
            className={`min-h-10 rounded-full border px-4 ${
              period === each ? 'border-primary bg-primary text-on-primary' : 'border-line'
            }`}
          >
            {t(`payouts.period.${each}` as MessageKey)}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError || !report ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : report.totals.statements === 0 ? (
        <Card>
          <EmptyState
            icon={<Landmark aria-hidden className="size-8 text-secondary" />}
            title={t('payouts.none')}
          />
        </Card>
      ) : (
        <>
          {report.truncated && <Alert tone="warning">{t('payouts.truncated')}</Alert>}
          <div className="grid grid-cols-2 gap-3">
            <Figure label={t('cash.statement.paid')} amount={report.totals.net.amount} />
            <Figure label={t('cash.statement.tax')} amount={report.totals.tax.amount} />
            <Figure label={t('settlements.fees')} amount={report.totals.fees.amount} />
            <Figure label={t('settlements.gross')} amount={report.totals.gross.amount} />
          </div>
          <FormSection title={t('payouts.sources')}>
            <ul className="flex flex-col divide-y divide-line">
              {report.sources.map((source) => (
                <li
                  key={`${source.kind}-${source.name}`}
                  className="flex flex-wrap items-baseline gap-x-3 py-2"
                >
                  <span className="min-w-0 flex-1 font-medium" dir="auto">
                    {source.name}
                    <span className="text-secondary font-normal">
                      {' · '}
                      {t(`payouts.kind.${source.kind}` as MessageKey)}
                    </span>
                  </span>
                  <span className="num font-medium">{formatMoney(source.net.amount)}</span>
                  <span className="basis-full text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t('payouts.statements', { count: formatCount(source.statements) })} ·{' '}
                    {t('settlements.deducted', {
                      fees: formatMoney(source.fees.amount),
                      tax: formatMoney(source.tax.amount),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </FormSection>
          {report.months.length > 1 && (
            <FormSection title={t('payouts.months')}>
              <ul className="flex flex-col divide-y divide-line">
                {report.months.map((month) => (
                  <li key={month.month} className="flex items-baseline gap-3 py-2">
                    <span className="min-w-0 flex-1">{formatMonth(month.month, locale)}</span>
                    <span className="text-secondary">
                      {t('payouts.taxOf', { tax: formatMoney(month.tax.amount) })}
                    </span>
                    <span className="num font-medium">{formatMoney(month.net.amount)}</span>
                  </li>
                ))}
              </ul>
            </FormSection>
          )}
          <FormSection title={t('payouts.withholdings')} hint={t('payouts.withholdings.hint')}>
            {report.withholdings.length === 0 ? (
              <p className="text-secondary">{t('payouts.withholdings.none')}</p>
            ) : (
              <>
                <ul className="flex flex-col divide-y divide-line">
                  {report.withholdings.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                      <span className="min-w-0 flex-1" dir="auto">
                        {row.name}
                        {row.reference && (
                          <span className="text-secondary">
                            {' · '}
                            <span dir="ltr">{row.reference}</span>
                          </span>
                        )}
                      </span>
                      <span className="num font-medium">{formatMoney(row.tax.amount)}</span>
                      <span className="basis-full text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                        {formatDate(row.importedAt, timezone, locale)}
                      </span>
                    </li>
                  ))}
                </ul>
                <Button
                  variant="secondary"
                  className="self-start"
                  icon={<Download aria-hidden className="size-5" />}
                  onClick={() => download(report.withholdings)}
                >
                  {t('payouts.download')}
                </Button>
              </>
            )}
          </FormSection>
        </>
      )}
    </div>
  );
}
