import { PosCustomerSalesQuery } from '../api/operations';
import type { PosSalesData } from '../api/types';
import { formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useAdminQuery } from '../shell/shop-context';

/** A customer's sales at the shop's till (ADR-872), the latest first: none shows nothing. */
export function TillSales({ customerId, timezone }: { customerId: string; timezone: string }) {
  const { t, locale } = useLocale();
  const sales = useAdminQuery<PosSalesData>(
    ['posCustomerSales', customerId],
    PosCustomerSalesQuery,
    {
      customerId,
    },
  );
  const nodes = sales.data?.posSales.nodes ?? [];
  if (nodes.length === 0) return null;
  return (
    <FormSection title={t('pos.tillSales')}>
      <ul
        aria-label={t('pos.tillSales')}
        className="-mx-4 divide-y divide-line border-t border-line"
      >
        {nodes.map((sale) => (
          <li key={sale.id} className="flex flex-col gap-1 px-4 py-3">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="num font-semibold">{sale.name}</span>
              <span className="flex-1 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {formatDate(sale.soldAt, timezone, locale)}
              </span>
              <span className="num font-medium">{formatMoney(sale.total.amount)}</span>
            </span>
            <span className="text-secondary" dir="auto">
              {sale.lines.map((line) => `${line.quantity} × ${line.title}`).join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </FormSection>
  );
}
