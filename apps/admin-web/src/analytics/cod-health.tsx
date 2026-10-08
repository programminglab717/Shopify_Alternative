import { useState } from 'react';
import { CodHealthQuery } from '../api/operations';
import type { CodHealthData, CodHealthDimension } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminQuery } from '../shell/shop-context';
import { Card, ErrorState, Loading } from '../ui/feedback';

/** A return rate from which a city, product or courier costs the shop more than it should. */
export const HIGH_RETURNS = 0.3;

const DIMENSIONS: readonly CodHealthDimension[] = ['CITY', 'PRODUCT', 'SOURCE', 'COURIER'];

/** A rate as a whole percentage, or a dash where there was nothing to count. */
export function percent(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '–' : `${Math.round(rate * 100)}%`;
}

function Rate({
  label,
  rate,
  hint,
  bad,
}: {
  label: MessageKey;
  rate: number | null;
  hint: string;
  bad?: boolean;
}) {
  const { t } = useLocale();
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-secondary">{t(label)}</span>
      <span
        className={`num text-[length:var(--hatti-type-title-size)] font-semibold ${
          bad ? 'text-danger' : ''
        }`}
      >
        {percent(rate)}
      </span>
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">{hint}</span>
    </Card>
  );
}

/**
 * COD health (COD-12, ADR-060) for the period the page shows: how many cash-on-delivery orders
 * were confirmed, how many parcels were delivered and how many came back, what returns cost; by
 * city, product, source or courier, a high return rate in red.
 */
export function CodHealth({ from, before }: { from: string; before: string }) {
  const { t } = useLocale();
  const [by, setBy] = useState<CodHealthDimension>('CITY');
  const query = useAdminQuery<CodHealthData>(['codHealth', from, before, by], CodHealthQuery, {
    placedFrom: from,
    placedBefore: before,
    by,
  });

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const { confirmation, delivery, rows } = query.data.codHealth;
  const finished = delivery.delivered + delivery.returned;

  return (
    <FormSection title={t('cod.health.title')} hint={t('cod.health.hint')}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Rate
          label="cod.health.confirmed"
          rate={confirmation.rate}
          hint={t('cod.health.confirmedOf', {
            count: confirmation.confirmed,
            decided: formatCount(confirmation.confirmed + confirmation.cancelled),
          })}
        />
        <Rate
          label="cod.health.delivered"
          rate={delivery.successRate}
          hint={t('cod.health.deliveredOf', {
            count: delivery.delivered,
            finished: formatCount(finished),
          })}
        />
        <Rate
          label="cod.health.returned"
          rate={delivery.returnRate}
          bad={(delivery.returnRate ?? 0) >= HIGH_RETURNS}
          hint={t('cod.health.returnedOf', {
            count: delivery.returned,
            finished: formatCount(finished),
          })}
        />
        <Card className="flex flex-col gap-1 p-4">
          <span className="text-secondary">{t('cod.health.returnCharges')}</span>
          <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">
            {formatMoney(delivery.returnCharges.amount)}
          </span>
          <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('cod.health.inTransit', { count: delivery.inTransit })}
          </span>
        </Card>
      </div>
      <SelectField
        label={t('cod.health.by')}
        value={by}
        options={DIMENSIONS.map((each) => ({
          value: each,
          label: t(`cod.health.by.${each}` as MessageKey),
        }))}
        onChange={setBy}
      />
      {rows.length === 0 ? (
        <p className="text-secondary">{t('cod.health.none')}</p>
      ) : (
        <table className="w-full text-start">
          <thead className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            <tr>
              <th className="py-1 text-start font-normal">
                {t(`cod.health.by.${by}` as MessageKey)}
              </th>
              <th className="py-1 text-end font-normal">
                {t(by === 'COURIER' ? 'cod.health.parcels' : 'cod.health.orders')}
              </th>
              {by !== 'COURIER' && (
                <th className="py-1 text-end font-normal">{t('cod.health.confirmed')}</th>
              )}
              <th className="py-1 text-end font-normal">{t('cod.health.returned')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => {
              const high = (row.delivery.returnRate ?? 0) >= HIGH_RETURNS;
              return (
                <tr key={row.key ?? row.title}>
                  <td className="py-2" dir="auto">
                    {row.key === null && by === 'COURIER' ? t('cod.health.noCourier') : row.title}
                  </td>
                  <td className="num py-2 text-end">
                    {formatCount(
                      by === 'COURIER' ? row.delivery.shipped : (row.confirmation?.placed ?? 0),
                    )}
                  </td>
                  {by !== 'COURIER' && (
                    <td className="num py-2 text-end">{percent(row.confirmation?.rate)}</td>
                  )}
                  <td className={`num py-2 text-end ${high ? 'font-semibold text-danger' : ''}`}>
                    {percent(row.delivery.returnRate)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </FormSection>
  );
}
