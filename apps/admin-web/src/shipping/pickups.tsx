import { ExternalLink, FileText, Hand, ScanBarcode, Truck } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CourierLoadSheetQuery,
  CourierPickupRecordByHandMutation,
  CourierPickupRequestMutation,
  PickupsQuery,
} from '../api/operations';
import type {
  CourierDocumentData,
  CourierPickup,
  CourierPickupRecordByHandData,
  CourierPickupRequestData,
  PickupsData,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { openPrintTab } from '../ui/print';
import { HandOver } from './hand-over';

const STATUS_TONE: Record<CourierPickup['status'], string> = {
  REQUESTING: 'text-secondary',
  REQUESTED: 'text-success',
  FAILED: 'text-danger',
};

/** Asks a courier to collect the parcels waiting, naming its rider where it asks. */
function RequestPickup({ data }: { data: PickupsData }) {
  const { t } = useLocale();
  const request = useAdminMutation<CourierPickupRequestData, { input: object }>(
    CourierPickupRequestMutation,
  );
  const takes = new Map(
    data.couriers.filter((each) => each.pickups).map((each) => [each.courier, each.pickups!]),
  );
  const accounts = data.courierAccounts.filter((account) => takes.has(account.courier));
  const [accountId, setAccountId] = useState(
    () => (accounts.find((account) => account.isDefault) ?? accounts[0])?.id ?? '',
  );
  const [riderName, setRiderName] = useState('');
  const [riderCode, setRiderCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);

  if (accounts.length === 0) {
    return <Alert tone="info">{t('pickups.none')}</Alert>;
  }
  const account = accounts.find((each) => each.id === accountId) ?? accounts[0]!;
  const rider = takes.get(account.courier)!.rider;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setAsked(null);
    try {
      const { courierPickupRequest } = await request.mutateAsync({
        input: {
          accountId: account.id,
          ...(rider ? { riderName: riderName.trim(), riderCode: riderCode.trim() } : {}),
        },
      });
      const error = courierPickupRequest.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else {
        setAsked(account.courierName);
        setRiderName('');
        setRiderCode('');
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <h2 className="font-semibold">{t('pickups.ask')}</h2>
        <p className="text-secondary">{t('pickups.askHint')}</p>
        {accounts.length > 1 && (
          <SelectField
            label={t('pickups.account')}
            value={account.id}
            options={accounts.map((each) => ({
              value: each.id,
              label: `${each.name} (${each.courierName})`,
            }))}
            onChange={setAccountId}
          />
        )}
        {rider && (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={t('pickups.riderName')}
              hint={t('pickups.riderHint', { courier: account.courierName })}
              dir="auto"
              required
              maxLength={100}
              value={riderName}
              onChange={(event) => setRiderName(event.target.value)}
            />
            <TextField
              label={t('pickups.riderCode')}
              ltr
              required
              maxLength={100}
              value={riderCode}
              onChange={(event) => setRiderCode(event.target.value)}
            />
          </div>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {asked && <Alert tone="success">{t('pickups.asked', { courier: asked })}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={request.isPending}
          icon={<Truck aria-hidden className="size-5" />}
        >
          {t('pickups.askSubmit', { courier: account.courierName })}
        </Button>
      </form>
    </Card>
  );
}

/**
 * The parcels waiting recorded as handed to a courier's rider by hand (ADR-378): a rider on the
 * courier's daily round, not asked for through its API, or one of a courier whose API takes none.
 * The rider's name and code where the shop wants them kept; then its parcels are checked off as
 * the rider takes them, from the pickup it makes.
 */
function RecordByHand({
  data,
  onRecorded,
}: {
  data: PickupsData;
  onRecorded: (pickupId: string) => void;
}) {
  const { t } = useLocale();
  const record = useAdminMutation<CourierPickupRecordByHandData, { input: object }>(
    CourierPickupRecordByHandMutation,
  );
  const accounts = data.courierAccounts;
  const [accountId, setAccountId] = useState(
    () => (accounts.find((account) => account.isDefault) ?? accounts[0])?.id ?? '',
  );
  const [riderName, setRiderName] = useState('');
  const [riderCode, setRiderCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  if (accounts.length === 0) return null;
  const account = accounts.find((each) => each.id === accountId) ?? accounts[0]!;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { courierPickupRecordByHand: result } = await record.mutateAsync({
        input: {
          accountId: account.id,
          ...(riderName.trim() ? { riderName: riderName.trim() } : {}),
          ...(riderCode.trim() ? { riderCode: riderCode.trim() } : {}),
        },
      });
      const error = result.userErrors[0];
      if (error || !result.courierPickup) setProblem(error ? problemText(error, t) : null);
      else {
        setRiderName('');
        setRiderCode('');
        onRecorded(result.courierPickup.id);
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <h2 className="font-semibold">{t('pickups.byHand')}</h2>
        <p className="text-secondary">{t('pickups.byHandHint')}</p>
        {accounts.length > 1 && (
          <SelectField
            label={t('pickups.account')}
            value={account.id}
            options={accounts.map((each) => ({
              value: each.id,
              label: `${each.name} (${each.courierName})`,
            }))}
            onChange={setAccountId}
          />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t('pickups.riderNameOptional')}
            dir="auto"
            maxLength={100}
            value={riderName}
            onChange={(event) => setRiderName(event.target.value)}
          />
          <TextField
            label={t('pickups.riderCodeOptional')}
            ltr
            maxLength={100}
            value={riderCode}
            onChange={(event) => setRiderCode(event.target.value)}
          />
        </div>
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button
          type="submit"
          variant="secondary"
          className="self-start"
          busy={record.isPending}
          icon={<Hand aria-hidden className="size-5" />}
        >
          {t('pickups.byHandSubmit')}
        </Button>
      </form>
    </Card>
  );
}

/**
 * Pickups (SHP-02, ADR-253): the parcels waiting handed to their courier through its API, which
 * sends a rider; each pickup asked for, with its parcels, the courier's number or load sheet,
 * and why a courier refused. Our own load sheet of a pickup is printed for the rider to sign.
 */
export function Pickups() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const store = useSessionStore();
  const query = useAdminQuery<PickupsData>(['pickups'], PickupsQuery, undefined, {
    // Read again while a courier is being asked, to show what it said.
    refetchInterval: (data) =>
      data?.courierPickups.some((pickup) => pickup.status === 'REQUESTING') ? 3000 : false,
  });
  const [problem, setProblem] = useState<string | null>(null);
  // The pickup whose parcels are being checked off as its rider takes them (ADR-377).
  const [handing, setHanding] = useState<string | null>(null);

  const printLoadSheet = async (pickup: CourierPickup) => {
    setProblem(null);
    const tab = openPrintTab();
    if (!tab) {
      setProblem(t('shipping.popupBlocked'));
      return;
    }
    try {
      const data = await store.graphql<{ courierLoadSheet: CourierDocumentData }>(
        shop.id,
        CourierLoadSheetQuery,
        { accountId: pickup.accountId, pickupId: pickup.id, language: 'BILINGUAL' },
      );
      tab.show(data.courierLoadSheet.html);
    } catch (failure) {
      tab.close();
      setProblem(errorText(failure, t));
    }
  };

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const names = new Map(query.data.courierAccounts.map((account) => [account.id, account.name]));
  const pickups = query.data.courierPickups;

  return (
    <div className="flex flex-col gap-4">
      <RequestPickup data={query.data} />
      <RecordByHand data={query.data} onRecorded={setHanding} />
      {problem && <Alert tone="danger">{problem}</Alert>}
      {pickups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Truck aria-hidden className="size-8 text-secondary" />}
            title={t('pickups.empty')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line" aria-label={t('pickups.list')}>
            {pickups.map((pickup) => (
              <li key={pickup.id} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold">
                    {names.get(pickup.accountId) ?? pickup.courierName}
                  </span>
                  <span className={`font-medium ${STATUS_TONE[pickup.status]}`}>
                    {pickup.byHand
                      ? t('pickups.status.BY_HAND')
                      : t(`pickups.status.${pickup.status}`)}
                  </span>
                  <span className="flex-1" />
                  <span className="text-secondary">
                    {formatRelative(
                      pickup.requestedAt ?? pickup.createdAt,
                      query.data.shop.timezone,
                      locale,
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 text-[length:var(--hatti-type-body-sm-size)] text-secondary">
                  <span>{t('pickups.parcels', { count: formatCount(pickup.parcelCount) })}</span>
                  {pickup.handedOverCount > 0 && (
                    <span>
                      {t('pickups.handedOver', {
                        handed: formatCount(pickup.handedOverCount),
                        count: formatCount(pickup.parcelCount),
                      })}
                    </span>
                  )}
                  {pickup.reference && (
                    <span>
                      {t('pickups.reference')} <span className="num">{pickup.reference}</span>
                    </span>
                  )}
                  {pickup.riderName && (
                    <span dir="auto">
                      {t('pickups.rider', { name: pickup.riderName })}
                      {pickup.riderCode && <span className="num"> · {pickup.riderCode}</span>}
                    </span>
                  )}
                </div>
                {pickup.error && <p className="text-danger">{pickup.error}</p>}
                {pickup.status === 'REQUESTED' && (
                  <div className="mt-1 flex flex-wrap gap-2">
                    {handing !== pickup.id && (
                      <Button
                        variant="secondary"
                        icon={<ScanBarcode aria-hidden className="size-5" />}
                        onClick={() => setHanding(pickup.id)}
                      >
                        {t('pickups.scan')}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      icon={<FileText aria-hidden className="size-5" />}
                      onClick={() => void printLoadSheet(pickup)}
                    >
                      {t('pickups.printLoadSheet')}
                    </Button>
                    {pickup.loadSheetUrl && (
                      <a
                        href={pickup.loadSheetUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-12 items-center gap-2 rounded-control px-4 font-medium text-primary hover:bg-canvas md:min-h-10"
                      >
                        <ExternalLink aria-hidden className="size-5" />
                        {t('pickups.courierLoadSheet', { courier: pickup.courierName })}
                      </a>
                    )}
                  </div>
                )}
                {pickup.status === 'REQUESTED' && handing === pickup.id && (
                  <HandOver pickupId={pickup.id} onClose={() => setHanding(null)} />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
