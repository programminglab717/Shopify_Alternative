import { Link } from '@tanstack/react-router';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SalesQuery } from '../api/operations';
import type { MoneyValue, SalesData, SalesTotalsValue } from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, ErrorState, Loading } from '../ui/feedback';
import { CodHealth } from './cod-health';

/** The roles that read the shop's sales (the core asks read_orders; these are the ones who plan). */
export const READS_ANALYTICS: readonly StaffRole[] = ['owner', 'manager', 'marketer', 'accountant'];

const DAY_MS = 86_400_000;
const PERIODS = [7, 30, 90] as const;
type Days = (typeof PERIODS)[number];

/** The start of the day `daysAgo` days before today, in the shop's time zone. */
export function startOfDay(timeZone: string, daysAgo: number, now = new Date()): Date {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const offset =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')
      ?.value.replace('GMT', '') || 'Z';
  return new Date(Date.parse(`${date}T00:00:00${offset}`) - daysAgo * DAY_MS);
}

/** How much `now` differs from `before`, as a whole percentage; null where before was nothing. */
export function change(now: number, before: number): number | null {
  if (before === 0) return null;
  return Math.round(((now - before) / before) * 100);
}

function Figure({
  label,
  now,
  before,
  shown,
}: {
  label: MessageKey;
  now: number;
  before: number;
  shown: string;
}) {
  const { t } = useLocale();
  const delta = change(now, before);
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-secondary">{t(label)}</span>
      <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">{shown}</span>
      {delta !== null && (
        <span
          className={`flex items-center gap-1 text-[length:var(--hatti-type-body-sm-size)] ${
            delta >= 0 ? 'text-success' : 'text-danger'
          }`}
        >
          {delta >= 0 ? (
            <TrendingUp aria-hidden className="size-4" />
          ) : (
            <TrendingDown aria-hidden className="size-4" />
          )}
          {t(delta >= 0 ? 'analytics.up' : 'analytics.down', { percent: Math.abs(delta) })}
        </span>
      )}
    </Card>
  );
}

const amount = (money: MoneyValue | null) => Number(money?.amount ?? 0);

function Totals({ now, before }: { now: SalesTotalsValue; before: SalesTotalsValue }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Figure
        label="analytics.netSales"
        now={amount(now.netSales)}
        before={amount(before.netSales)}
        shown={formatMoney(now.netSales.amount)}
      />
      <Figure
        label="analytics.orders"
        now={now.orders}
        before={before.orders}
        shown={formatCount(now.orders)}
      />
      <Figure
        label="analytics.average"
        now={amount(now.averageOrderValue)}
        before={amount(before.averageOrderValue)}
        shown={now.averageOrderValue ? formatMoney(now.averageOrderValue.amount) : '–'}
      />
      <Figure
        label="analytics.profit"
        now={amount(now.profit)}
        before={amount(before.profit)}
        shown={formatMoney(now.profit.amount)}
      />
    </div>
  );
}

/** Net sales by day or week as bars, each saying what it was to a screen reader. */
function Bars({ periods }: { periods: SalesData['salesReport']['periods'] }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const most = Math.max(...periods.map((period) => amount(period.sales.netSales)), 1);
  const first = periods[0];
  const last = periods.at(-1);
  return (
    <FormSection title={t('analytics.overTime')}>
      <ul className="flex h-40 items-end gap-px" aria-label={t('analytics.overTime')}>
        {periods.map((period) => {
          const value = amount(period.sales.netSales);
          const label = t('analytics.bar', {
            date: formatDate(period.start, timezone, locale),
            sales: formatMoney(period.sales.netSales.amount),
            count: period.sales.orders,
          });
          return (
            <li
              key={period.start}
              aria-label={label}
              title={label}
              className="flex h-full min-w-0 flex-1 items-end"
            >
              <span
                className={`w-full rounded-t-sm ${value > 0 ? 'bg-primary' : 'bg-line'}`}
                style={{ height: `${Math.max((value / most) * 100, value > 0 ? 2 : 1)}%` }}
              />
            </li>
          );
        })}
      </ul>
      {first && last && (
        <div className="flex justify-between text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          <span>{formatDate(first.start, timezone, locale)}</span>
          <span>{formatDate(last.start, timezone, locale)}</span>
        </div>
      )}
    </FormSection>
  );
}

/**
 * Sales over time (ANL-02, ADR-250): the last 7, 30 or 90 days against the period as long before,
 * net sales by day (by week over 90), what sold most, where the orders came from, and how its
 * cash-on-delivery orders turned out.
 */
export function AnalyticsPage() {
  const { t } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  const [days, setDays] = useState<Days>(30);
  // Whole days in the shop's time zone, today's included.
  const { from, before } = useMemo(
    () => ({
      from: startOfDay(timezone, days - 1).toISOString(),
      before: startOfDay(timezone, -1).toISOString(),
    }),
    [days, timezone],
  );
  const query = useAdminQuery<SalesData>(['sales', days], SalesQuery, {
    placedFrom: from,
    placedBefore: before,
    interval: days === 90 ? 'WEEK' : 'DAY',
  });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 pb-8">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('analytics.title')}
      </h1>
      <div role="tablist" className="flex gap-2">
        {PERIODS.map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={days === each}
            onClick={() => setDays(each)}
            className={`min-h-10 rounded-full border px-4 ${
              days === each ? 'border-primary bg-primary text-on-primary' : 'border-line'
            }`}
          >
            {t('analytics.days', { count: each })}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <>
          <p className="text-secondary">{t('analytics.against', { count: days })}</p>
          <Totals
            now={query.data.salesReport.totals}
            before={query.data.salesReport.previous.totals}
          />
          <Bars periods={query.data.salesReport.periods} />
          <div className="grid gap-4 md:grid-cols-2">
            <FormSection title={t('analytics.topProducts')}>
              {query.data.salesReport.topProducts.length === 0 ? (
                <p className="text-secondary">{t('analytics.noSales')}</p>
              ) : (
                <ol className="flex flex-col divide-y divide-line">
                  {query.data.salesReport.topProducts.map((product) => (
                    <li key={product.productId} className="flex items-baseline gap-3 py-2">
                      <Link
                        to="/$shopId/products/$productId"
                        params={{ shopId, productId: product.productId }}
                        className="min-w-0 flex-1 underline-offset-4 hover:underline"
                        dir="auto"
                      >
                        {product.title}
                      </Link>
                      <span className="text-secondary">
                        {t('analytics.units', { count: product.unitsSold })}
                      </span>
                      <span className="num font-medium">
                        {formatMoney(product.grossSales.amount)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </FormSection>
            <FormSection title={t('analytics.sources')}>
              {query.data.salesReport.rows.length === 0 ? (
                <p className="text-secondary">{t('analytics.noSales')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {query.data.salesReport.rows.map((row) => (
                    <li key={row.key ?? row.title} className="flex items-baseline gap-3 py-2">
                      <span className="min-w-0 flex-1">{row.title}</span>
                      <span className="text-secondary">
                        {t('analytics.ordersCount', { count: row.sales.orders })}
                      </span>
                      <span className="num font-medium">
                        {formatMoney(row.sales.netSales.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </FormSection>
          </div>
        </>
      )}
      <CodHealth from={from} before={before} />
    </div>
  );
}
