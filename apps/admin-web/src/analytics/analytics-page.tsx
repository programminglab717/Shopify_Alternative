import { Link } from '@tanstack/react-router';
import { Gauge } from 'lucide-react';
import { useState } from 'react';
import { SalesQuery } from '../api/operations';
import type { MoneyValue, SalesData, SalesTotalsValue } from '../api/types';
import { gate, permits } from '../auth/permissions';
import { SEES_AGENTS } from '../desk/agents-page';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney, formatTimes } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { ErrorState, Loading } from '../ui/feedback';
import { CodHealth } from './cod-health';
import { CourierPerformance } from './courier-performance';
import { Bars, Figure } from './figures';
import { type Days, PeriodTabs, usePeriod } from './period';
import { Searches } from './searches';
import { StockReport } from './stock-report';
import { LiveView, Visits } from './visits';

/** The roles that read the shop's sales (the core asks read_orders; these are the ones who plan). */
export const READS_ANALYTICS = gate(['owner', 'manager', 'marketer', 'accountant'], 'read_orders');

const amount = (money: MoneyValue | null) => Number(money?.amount ?? 0);

function Totals({
  now,
  before,
  trueProfit,
}: {
  now: SalesTotalsValue;
  before: SalesTotalsValue;
  trueProfit: boolean;
}) {
  const { t } = useLocale();
  // Couriers' charges no statement has said yet, estimated by rate cards (ADR-383).
  const estimated = amount(now.shippingCostsEstimated ?? null);
  // What the ads cost, recorded on Marketing's ad spend (ADR-553), and what they brought in.
  const adSpend = trueProfit && now.adSpend && amount(now.adSpend) > 0 ? now.adSpend : null;
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
      {now.profit ? (
        <Figure
          label="analytics.profit"
          now={amount(now.profit)}
          before={amount(before.profit)}
          shown={formatMoney(now.profit.amount)}
          note={
            estimated > 0
              ? t('analytics.profitEstimated', {
                  amount: formatMoney(now.shippingCostsEstimated!.amount),
                })
              : null
          }
        />
      ) : (
        // A plan without true profit (ADR-529): gross profit, saying which plans give the rest.
        <Figure
          label="analytics.grossProfit"
          now={amount(now.grossProfit ?? null)}
          before={amount(before.grossProfit ?? null)}
          shown={formatMoney(now.grossProfit?.amount ?? '0')}
          note={t('analytics.trueProfitPlan')}
        />
      )}
      {adSpend && (
        <>
          <Figure
            label="analytics.adSpend"
            now={amount(adSpend)}
            before={amount(before.adSpend ?? null)}
            shown={formatMoney(adSpend.amount, adSpend.currencyCode)}
          />
          <Figure
            label="analytics.returnOnAdSpend"
            now={now.returnOnAdSpend ?? 0}
            before={before.returnOnAdSpend ?? 0}
            shown={typeof now.returnOnAdSpend === 'number' ? formatTimes(now.returnOnAdSpend) : '–'}
            note={t('analytics.returnOnAdSpendNote')}
          />
        </>
      )}
    </div>
  );
}

/**
 * Sales over time (ANL-02, ADR-250): who is on the online store now; the last 7, 30 or 90 days
 * against the period as long before, with what the ads cost and brought in (ADR-553), net sales
 * by day (by week over 90), what sold most, where the orders came from, the online store's visits
 * and how far they went, what shoppers searched it for (ADR-684), how its cash-on-delivery orders
 * turned out, and how its stock sold (ANL-05); for owners and managers, the way to how each agent
 * of the Confirmation Desk did.
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
            trueProfit={query.data.salesReport.trueProfit === true}
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
      <Searches days={days} />
      <CodHealth from={from} before={before} />
      <CourierPerformance from={from} before={before} />
      <StockReport days={days} />
      {permits(shop, SEES_AGENTS) && (
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
