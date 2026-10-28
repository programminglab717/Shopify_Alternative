import { PackageCheck } from 'lucide-react';
import { useState } from 'react';
import { PosPickupHandOverMutation, PosPickupsQuery } from '../api/operations';
import type {
  PosPickupHandOverData,
  PosPickupsData,
  PosRegisterValue,
  PosTenderMethod,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { METHOD_LABELS, METHODS } from './till';

/**
 * Click-and-collect orders waiting at the register's location (POS-06, ADR-873), the oldest
 * first: each handed over at the till, what it still owes paid there, into the drawer or as
 * chosen. One not confirmed, or waiting for its transfer, waits.
 */
export function Pickups({
  register,
  sessionId,
}: {
  register: PosRegisterValue;
  sessionId: string;
}) {
  const { t } = useLocale();
  const pickups = useAdminQuery<PosPickupsData>(['posPickups', register.id], PosPickupsQuery, {
    registerId: register.id,
  });
  const hand = useAdminMutation<
    PosPickupHandOverData,
    { sessionId: string; orderId: string; method: PosTenderMethod }
  >(PosPickupHandOverMutation);
  const [method, setMethod] = useState<PosTenderMethod>('CASH');
  const [said, setSaid] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  if (pickups.isPending) return <Loading label={t('state.loading')} />;
  if (pickups.isError) {
    return (
      <ErrorState
        message={errorText(pickups.error, t)}
        action={<Button onClick={() => void pickups.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const list = pickups.data.posPickups ?? [];
  const handOver = async (orderId: string, name: string) => {
    setSaid(null);
    try {
      const { posPickupHandOver } = await hand.mutateAsync({ sessionId, orderId, method });
      const error = posPickupHandOver.userErrors[0];
      if (error) setSaid({ tone: 'danger', text: problemText(error, t) });
      else {
        const paid = posPickupHandOver.paid?.amount ?? '0';
        setSaid({
          tone: 'success',
          text:
            Number(paid) > 0
              ? t('pos.handedPaid', { name, amount: formatMoney(paid) })
              : t('pos.handed', { name }),
        });
      }
    } catch (failure) {
      setSaid({ tone: 'danger', text: errorText(failure, t) });
    }
  };
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-[length:var(--hatti-type-title-size)] font-semibold">
        {t('pos.pickupsTitle')}
      </h2>
      {said && <Alert tone={said.tone}>{said.text}</Alert>}
      {list.length === 0 ? (
        <EmptyState
          icon={<PackageCheck aria-hidden className="size-8 text-secondary" />}
          title={t('pos.noPickups')}
        />
      ) : (
        <>
          <SelectField
            label={t('pos.collectBy')}
            value={method}
            options={METHODS.map((each) => ({ value: each, label: t(METHOD_LABELS[each]) }))}
            onChange={setMethod}
          />
          <ul aria-label={t('pos.pickupsTitle')} className="flex flex-col divide-y divide-line">
            {list.map((pickup) => (
              <li key={pickup.orderId} className="flex flex-wrap items-center gap-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{pickup.name}</span>
                  {pickup.customerName && (
                    <span className="text-secondary" dir="auto">
                      {pickup.customerName}
                    </span>
                  )}
                  {!pickup.ready && <span className="text-warning">{t('pos.pickupWaits')}</span>}
                </span>
                <Button
                  disabled={!pickup.ready}
                  busy={hand.isPending && hand.variables?.orderId === pickup.orderId}
                  aria-label={t('pos.handOverOf', { name: pickup.name })}
                  onClick={() => void handOver(pickup.orderId, pickup.name)}
                >
                  {Number(pickup.owed.amount) > 0
                    ? t('pos.handOverCollect', { amount: formatMoney(pickup.owed.amount) })
                    : t('pos.handOver')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
