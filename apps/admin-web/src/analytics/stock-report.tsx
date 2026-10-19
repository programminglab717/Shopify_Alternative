import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { InventoryReportQuery } from '../api/operations';
import type {
  InventoryReportData,
  InventoryReportRowValue,
  InventoryReportSortKey,
} from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { SEES_STOCK_WORTH } from '../stock/stock-page';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Card, ErrorState, Loading } from '../ui/feedback';
import type { Days } from './period';

const SORT_KEYS: readonly InventoryReportSortKey[] = ['SELL_THROUGH', 'SLOWEST', 'STOCKOUTS'];

/** A share already in percent, to a whole one, or a dash where there was nothing to count. */
const percent = (value: number | null) => (value === null ? '–' : `${Math.round(value)}%`);

function Count({ label, shown, hint }: { label: MessageKey; shown: string; hint?: string }) {
  const { t } = useLocale();
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-secondary">{t(label)}</span>
      <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">{shown}</span>
      {hint && (
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">{hint}</span>
      )}
    </Card>
  );
}

/** What the list's last column says of a variant, for the order it is listed in. */
function useLast(sortKey: InventoryReportSortKey) {
  const { t } = useLocale();
  return (row: InventoryReportRowValue): string => {
    if (sortKey === 'SELL_THROUGH') return percent(row.sellThrough);
    if (sortKey === 'SLOWEST') {
      return row.daysSinceSale === null
        ? t('stockReport.never')
        : t('stockReport.daysAgo', { count: row.daysSinceSale });
    }
    return t('stockReport.daysOut', {
      days: row.daysOut.toLocaleString('en-PK', { maximumFractionDigits: 1 }),
      count: row.stockouts,
    });
  };
}

/**
 * Stock over the period the page shows (ANL-05, ADR-455): how much of what there was sold, how
 * long ago the stock on hand last sold, and what ran out; the variants that sold through most,
 * that sit unsold longest, or that were out longest. What the ageing stock cost, for those who
 * see what the stock is worth.
 */
export function StockReport({ days }: { days: Days }) {
  const { t } = useLocale();
  const shop = useShop();
  const [sortKey, setSortKey] = useState<InventoryReportSortKey>('SELL_THROUGH');
  const query = useAdminQuery<InventoryReportData>(
    ['inventoryReport', days, sortKey],
    InventoryReportQuery,
    { days, sortKey },
  );
  const last = useLast(sortKey);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const report = query.data.inventoryReport;
  const worth = permits(shop, SEES_STOCK_WORTH);

  return (
    <FormSection title={t('stockReport.title')} hint={t('stockReport.hint')}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Count
          label="stockReport.sold"
          shown={formatCount(report.sold)}
          hint={t('stockReport.onHand', { count: report.onHand })}
        />
        <Count label="stockReport.sellThrough" shown={percent(report.sellThrough)} />
        <Count label="stockReport.ranOut" shown={formatCount(report.ranOut)} />
        <Count label="stockReport.outNow" shown={formatCount(report.outNow)} />
      </div>
      {report.onHand > 0 && (
        <table className="w-full text-start">
          <caption className="pb-1 text-start font-medium">{t('stockReport.ageing')}</caption>
          <thead className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            <tr>
              <th className="py-1 text-start font-normal">{t('stockReport.lastSold')}</th>
              <th className="py-1 text-end font-normal">{t('stockReport.units')}</th>
              {worth && <th className="py-1 text-end font-normal">{t('stockReport.atCost')}</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {report.ageing.map((each) => (
              <tr key={each.bucket}>
                <td className="py-2">{t(`stockReport.bucket.${each.bucket}` as MessageKey)}</td>
                <td className="num py-2 text-end">{formatCount(each.units)}</td>
                {worth && <td className="num py-2 text-end">{formatMoney(each.value.amount)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <SelectField
        label={t('stockReport.show')}
        value={sortKey}
        options={SORT_KEYS.map((each) => ({
          value: each,
          label: t(`stockReport.sort.${each}` as MessageKey),
        }))}
        onChange={setSortKey}
      />
      {report.rows.length === 0 ? (
        <p className="text-secondary">{t(`stockReport.none.${sortKey}` as MessageKey)}</p>
      ) : (
        <table className="w-full text-start">
          <thead className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            <tr>
              <th className="py-1 text-start font-normal">{t('stockReport.variant')}</th>
              <th className="py-1 text-end font-normal">{t('stockReport.soldShort')}</th>
              <th className="py-1 text-end font-normal">{t('stockReport.available')}</th>
              <th className="py-1 text-end font-normal">
                {t(`stockReport.column.${sortKey}` as MessageKey)}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {report.rows.map((row) => (
              <tr key={row.variantId}>
                <td className="py-2">
                  <Link
                    to="/$shopId/products/$productId"
                    params={{ shopId: shop.id, productId: row.productId }}
                    className="underline-offset-4 hover:underline"
                    dir="auto"
                  >
                    {row.productTitle}
                  </Link>
                  {row.variantTitle !== 'Default Title' && (
                    <span className="text-secondary block" dir="auto">
                      {row.variantTitle}
                    </span>
                  )}
                </td>
                <td className="num py-2 text-end">{formatCount(row.sold)}</td>
                <td className="num py-2 text-end">{formatCount(row.available)}</td>
                <td className="num py-2 text-end">{last(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </FormSection>
  );
}
