import { CheckCircle2, ScanBarcode } from 'lucide-react';
import { useState } from 'react';
import { CourierPickupParcelHandOverMutation, CourierPickupParcelsQuery } from '../api/operations';
import type { CourierPickupParcelHandOverData, CourierPickupParcelsData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Scanner, canScan } from '../stock/scanner';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';

type Said = { tone: 'success' | 'warning' | 'danger'; text: string };

/**
 * A pickup's parcels checked off as the courier's rider takes them (SHP-02, APP-04, ADR-377):
 * each label's tracking number scanned with the camera or typed, the core saying which order's
 * parcel it is, or that it was checked off already or is not in this pickup; how many are handed
 * over, and the ones still on the table.
 */
export function HandOver({ pickupId, onClose }: { pickupId: string; onClose: () => void }) {
  const { t } = useLocale();
  const query = useAdminQuery<CourierPickupParcelsData>(
    ['courierPickupParcels'],
    CourierPickupParcelsQuery,
    { id: pickupId },
  );
  const handOver = useAdminMutation<
    CourierPickupParcelHandOverData,
    { pickupId: string; trackingNumber: string }
  >(CourierPickupParcelHandOverMutation);
  const [code, setCode] = useState('');
  const [said, setSaid] = useState<Said | null>(null);
  const [scanning, setScanning] = useState(false);

  const scanned = async (trackingNumber: string) => {
    setSaid(null);
    try {
      const { courierPickupParcelHandOver: result } = await handOver.mutateAsync({
        pickupId,
        trackingNumber,
      });
      const error = result.userErrors[0];
      if (error || !result.parcel) {
        setSaid({ tone: 'danger', text: error ? problemText(error, t) : t('state.error') });
        return;
      }
      const order = result.parcel.booking.orderName;
      setSaid(
        result.alreadyHandedOver
          ? { tone: 'warning', text: t('pickups.already', { order }) }
          : { tone: 'success', text: t('pickups.handed', { order }) },
      );
      setCode('');
    } catch (failure) {
      setSaid({ tone: 'danger', text: errorText(failure, t) });
    }
  };

  let parcels;
  if (query.isPending) parcels = <Loading label={t('state.loading')} />;
  else if (query.isError || !query.data.courierPickup) {
    parcels = (
      <ErrorState
        message={query.isError ? errorText(query.error, t) : t('state.error')}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else {
    const pickup = query.data.courierPickup;
    const left = pickup.parcels.filter((parcel) => parcel.handedOverAt === null);
    parcels = (
      <>
        <p className="font-medium">
          {t('pickups.handedOver', {
            handed: formatCount(pickup.handedOverCount),
            count: formatCount(pickup.parcelCount),
          })}
        </p>
        {left.length === 0 ? (
          <p className="flex items-center gap-2 text-success">
            <CheckCircle2 aria-hidden className="size-5" />
            {t('pickups.allHanded', { count: pickup.parcelCount })}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <h4 className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('pickups.toHand')}
            </h4>
            <ul aria-label={t('pickups.toHand')} className="flex flex-col gap-1">
              {left.map((parcel) => (
                <li key={parcel.booking.id} className="flex flex-wrap gap-x-3">
                  <span className="font-medium">{parcel.booking.orderName}</span>
                  <span dir="ltr" className="num text-secondary">
                    {parcel.booking.trackingNumber}
                  </span>
                  {parcel.booking.parcelStatus && parcel.booking.parcelStatus !== 'BOOKED' && (
                    // Taken without being checked off: the courier's tracking has it (ADR-379).
                    <span className="text-success">{t('pickups.courierHasIt')}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="mt-2 flex flex-col gap-3 rounded-control border border-line p-3">
      <h3 className="font-semibold">{t('pickups.scanTitle')}</h3>
      <p className="text-secondary">{t('pickups.scanHint')}</p>
      <form
        className="flex min-w-0 gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim()) void scanned(code.trim());
        }}
      >
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-label={t('pickups.trackingNumber')}
          placeholder={t('pickups.trackingNumber')}
          dir="ltr"
          autoComplete="off"
          autoFocus
          className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
        <Button type="submit" variant="secondary" disabled={!code.trim()} busy={handOver.isPending}>
          {t('pickups.checkOff')}
        </Button>
      </form>
      {canScan() &&
        (scanning ? (
          <Scanner
            continuous
            onCode={(read) => void scanned(read)}
            onClose={() => setScanning(false)}
          />
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            icon={<ScanBarcode aria-hidden className="size-5" />}
            onClick={() => setScanning(true)}
          >
            {t('stock.scan')}
          </Button>
        ))}
      {said && <Alert tone={said.tone}>{said.text}</Alert>}
      {parcels}
      <Button variant="secondary" className="self-start" onClick={onClose}>
        {t('pickups.closeScan')}
      </Button>
    </section>
  );
}
