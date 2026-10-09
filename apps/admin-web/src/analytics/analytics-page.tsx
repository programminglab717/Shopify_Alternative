import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { SalesQuery } from '../api/operations';
import type { MoneyValue, SalesData, SalesTotalsValue } from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { ErrorState, Loading } from '../ui/feedback';
import { CodHealth } from './cod-health';
import { Bars, Figure } from './figures';
import { LiveView, Visits } from './visits';

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

/**
 * Sales over time (ANL-02, ADR-250): who is on the online store now; the last 7, 30 or 90 days
 * against the period as long before, net sales by day (by week over 90), what sold most, where
 * the orders came from, the online store's visits and how far they went, and how its
 * cash-on-delivery orders turned out.
 */
export function AnalyticsPage() {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  const [days, setDays] = useState<Days>(30);
  // Whole days in the shop's time zone, today's included, and as many before them.
  const { from, before, previousFrom } = useMemo(
    () => ({
      from: startOfDay(timezone, days - 1).toISOString(),
      before: startOfDay(timezone, -1).toISOString(),
      previousFrom: startOfDay(timezone, 2 * days - 1).toISOString(),
    }),
    [days, timezone],
  );
  const interval = days === 90 ? 'WEEK' : 'DAY';
  const query = useAdminQuery<SalesData>(['sales', days], SalesQuery, {
    placedFrom: from,
    placedBefore: before,
    interval,
  });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 pb-8">
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('analytics.title')}
      </h1>
      <LiveView />
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
          <Bars
            title={t('analytics.overTime')}
            bars={query.data.salesReport.periods.map((period) => ({
              start: period.start,
              value: amount(period.sales.netSales),
              label: t('analytics.bar', {
                date: formatDate(period.start, timezone, locale),
                sales: formatMoney(period.sales.netSales.amount),
                count: period.sales.orders,
              }),
            }))}
          />
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
      <Visits from={from} before={before} previousFrom={previousFrom} interval={interval} />
      <CodHealth from={from} before={before} />
    </div>
  );
}
