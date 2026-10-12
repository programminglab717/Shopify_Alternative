import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { CourierPerformanceQuery } from '../api/operations';
import type { CourierPerformanceData, CourierTallyValue } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useAdminQuery } from '../shell/shop-context';
import { ErrorState, Loading } from '../ui/feedback';
import { HIGH_RETURNS, percent } from './cod-health';

/** Days to a tenth, or a dash while none was delivered. */
function days(value: number | null): string {
  return value === null ? '–' : value.toFixed(1);
}

/** A courier's figures, or one city's, as the table's cells after the first. */
function Figures({ tally }: { tally: CourierTallyValue }) {
  const high = (tally.returnRate ?? 0) >= HIGH_RETURNS;
  return (
    <>
      <td className="num py-2 ps-3 text-end">{formatCount(tally.shipped)}</td>
      <td className="num py-2 ps-3 text-end">{percent(tally.deliveryRate)}</td>
      <td className={`num py-2 ps-3 text-end ${high ? 'font-semibold text-danger' : ''}`}>
        {percent(tally.returnRate)}
      </td>
      <td className="num py-2 ps-3 text-end">{days(tally.daysToDeliver)}</td>
      <td className="num py-2 ps-3 text-end">
        {tally.chargePerParcel ? formatMoney(tally.chargePerParcel.amount) : '–'}
      </td>
    </>
  );
}

/**
 * Couriers' performance (SHP-08, ADR-384) for the period the page shows: for each courier, the
 * parcels it was given, how many it delivered and brought back, the days it took and what each
 * parcel cost; its busiest cities opened beneath it, to see which courier to send where.
 */
export function CourierPerformance({ from, before }: { from: string; before: string }) {
  const { t } = useLocale();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const query = useAdminQuery<CourierPerformanceData>(
    ['courierPerformance', from, before],
    CourierPerformanceQuery,
    { shippedFrom: from, shippedBefore: before },
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const couriers = query.data.courierPerformance;
  const estimated = couriers.reduce(
    (sum, courier) => sum + Number(courier.chargesEstimated.amount),
    0,
  );
  const toggle = (key: string) =>
    setOpen((before) => {
      const next = new Set(before);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <FormSection title={t('couriers.performance.title')} hint={t('couriers.performance.hint')}>
      {couriers.length === 0 ? (
        <p className="text-secondary">{t('couriers.performance.none')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-start">
            <thead className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              <tr>
                <th className="py-1 text-start font-normal">{t('cod.health.by.COURIER')}</th>
                <th className="py-1 ps-3 text-end font-normal">{t('cod.health.parcels')}</th>
                <th className="py-1 ps-3 text-end font-normal">{t('cod.health.delivered')}</th>
                <th className="py-1 ps-3 text-end font-normal">{t('cod.health.returned')}</th>
                <th className="py-1 ps-3 text-end font-normal">{t('couriers.performance.days')}</th>
                <th className="py-1 ps-3 text-end font-normal">
                  {t('couriers.performance.perParcel')}
                </th>
              </tr>
            </thead>
            {couriers.map((courier) => {
              const key = courier.courier ?? '';
              const name = courier.courier ?? t('cod.health.noCourier');
              const shown = open.has(key);
              return (
                <tbody key={key} className="divide-y divide-line border-t border-line">
                  <tr>
                    <td className="py-2">
                      {courier.cities.length === 0 ? (
                        <span dir="auto">{name}</span>
                      ) : (
                        <button
                          type="button"
                          aria-expanded={shown}
                          aria-label={t('couriers.performance.cities', { courier: name })}
                          onClick={() => toggle(key)}
                          className="inline-flex min-h-10 items-center gap-1 text-start font-semibold hover:underline"
                        >
                          <ChevronDown
                            aria-hidden
                            className={`size-4 transition-transform ${shown ? '' : 'ltr:-rotate-90 rtl:rotate-90'}`}
                          />
                          <span dir="auto">{name}</span>
                        </button>
                      )}
                    </td>
                    <Figures tally={courier} />
                  </tr>
                  {shown &&
                    courier.cities.map((city) => (
                      <tr key={city.city} className="text-secondary">
                        <td className="py-2 ps-6" dir="auto">
                          {city.city}
                        </td>
                        <Figures tally={city} />
                      </tr>
                    ))}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
      {estimated > 0 && (
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('couriers.performance.estimated', { amount: formatMoney(estimated.toFixed(2)) })}
        </p>
      )}
    </FormSection>
  );
}
