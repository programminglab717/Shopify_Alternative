import { Link } from '@tanstack/react-router';
import { Gauge } from 'lucide-react';
import { useState } from 'react';
import { SalesQuery } from '../api/operations';
import type { MoneyValue, SalesData, SalesTotalsValue } from '../api/types';
import type { StaffRole } from '../auth/session';
import { SEES_AGENTS } from '../desk/agents-page';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { ErrorState, Loading } from '../ui/feedback';
import { CodHealth } from './cod-health';
import { Bars, Figure } from './figures';
import { type Days, PeriodTabs, usePeriod } from './period';
import { LiveView, Visits } from './visits';

/** The roles that read the shop's sales (the core asks read_orders; these are the ones who plan). */
export const READS_ANALYTICS: readonly StaffRole[] = ['owner', 'manager', 'marketer', 'accountant'];

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
 * cash-on-delivery orders turned out; for owners and managers, the way to how each agent of the
 * Confirmation Desk did.
 */
export function AnalyticsPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const shopId = shop.id;
  const timezone = useShopTimezone();
  const [days, setDays] = useState<Days>(30);
  const { from, before, previousFrom } = usePeriod(days);
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
      <PeriodTabs days={days} onChange={setDays} />
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
      {SEES_AGENTS.includes(shop.role) && (
        <Link
          to="/$shopId/desk/agents"
          params={{ shopId: shop.id }}
          className="inline-flex min-h-10 items-center gap-2 self-start rounded-control border border-line bg-surface px-3 hover:bg-canvas"
        >
          <Gauge aria-hidden className="size-5" />
          {t('agents.title')}
        </Link>
      )}
    </div>
  );
}
