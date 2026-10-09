import { useNavigate, useSearch } from '@tanstack/react-router';
import { PackageCheck, ScanLine, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ParcelCheckInMutation,
  ParcelMarkLostMutation,
  ReturningParcelsQuery,
} from '../api/operations';
import type { ParcelCheckInData, ParcelUserErrorsData, ReturningParcelsData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { Claims, Lost } from './claims';
import { CHECKS_IN, CLAIMS, ParcelTitle, RETURNS_TABS, SLOW_RETURN_DAYS } from './parcel';
import type { ReturnsTab } from './parcel';

/** The tab a link to the section opens: coming back, unless it names another. */
export function validateReturnsSearch(search: Record<string, unknown>): { tab?: ReturnsTab } {
  return RETURNS_TABS.includes(search.tab as ReturnsTab) && search.tab !== 'back'
    ? { tab: search.tab as ReturnsTab }
    : {};
}

/**
 * Checks a parcel in by the tracking number on its label, typed or scanned: everything in it
 * goes back on the shelf.
 */
function CheckIn() {
  const { t } = useLocale();
  const [number, setNumber] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const checkIn = useAdminMutation<ParcelCheckInData, { trackingNumber: string }>(
    ParcelCheckInMutation,
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trackingNumber = number.trim();
    if (!trackingNumber) return;
    setDone(null);
    setProblem(null);
    try {
      const result = (await checkIn.mutateAsync({ trackingNumber })).fulfillmentReceiveReturn;
      if (result.userErrors.length > 0) {
        setProblem(result.userErrors.map((error) => problemText(error, t)).join(' '));
        return;
      }
      setDone(result.order?.name ?? trackingNumber);
      setNumber('');
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <TextField
          label={t('returns.checkIn.number')}
          hint={t('returns.checkIn.hint')}
          value={number}
          ltr
          autoComplete="off"
          onChange={(event) => setNumber(event.target.value)}
        />
        <Button
          type="submit"
          icon={<ScanLine aria-hidden className="size-5" />}
          className="self-start"
          busy={checkIn.isPending}
          disabled={!number.trim()}
        >
          {t('returns.checkIn')}
        </Button>
      </form>
      {done && <Alert tone="success">{t('returns.checkIn.done', { order: done })}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </Card>
  );
}

function ComingBack() {
  const { t } = useLocale();
  const { role } = useShop();
  const query = useAdminQuery<ReturningParcelsData>(['returningParcels'], ReturningParcelsQuery);
  const checkIn = useAdminMutation<ParcelCheckInData, { id: string }>(ParcelCheckInMutation);
  const markLost = useAdminMutation<ParcelUserErrorsData, { id: string }>(ParcelMarkLostMutation);
  const [losing, setLosing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const works = CHECKS_IN.includes(role);

  const act = async (run: () => Promise<{ userErrors: { message: string }[] }>) => {
    setProblem(null);
    try {
      const result = await run();
      if (result.userErrors.length > 0) {
        setProblem(result.userErrors.map((error) => error.message).join(' '));
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const parcels = query.data.returningParcels.nodes;

  return (
    <>
      {works && <CheckIn />}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {parcels.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PackageCheck aria-hidden className="size-8 text-success" />}
            title={t('returns.back.none')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {parcels.map((parcel) => {
              const slow = parcel.days >= SLOW_RETURN_DAYS;
              return (
                <li key={parcel.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <ParcelTitle
                      orderId={parcel.orderId}
                      orderName={parcel.orderName}
                      tracking={parcel.trackingInfo}
                    />
                    <span className="flex flex-col items-end text-[length:var(--hatti-type-body-sm-size)]">
                      <span className={slow ? 'font-semibold text-danger' : 'text-secondary'}>
                        {parcel.days === 0
                          ? t('returns.back.today')
                          : t('returns.back.days', { count: formatCount(parcel.days) })}
                      </span>
                      <span className="text-secondary">
                        {t('returns.items', { count: formatCount(parcel.units) })}
                      </span>
                    </span>
                  </div>
                  {works &&
                    (losing === parcel.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex-1">{t('returns.lost.confirm')}</span>
                        <Button
                          variant="destructive"
                          busy={markLost.isPending}
                          onClick={() =>
                            void act(async () => {
                              const result = await markLost.mutateAsync({ id: parcel.id });
                              setLosing(null);
                              return result.fulfillmentMarkLost!;
                            })
                          }
                        >
                          {t('returns.lost.mark')}
                        </Button>
                        <Button variant="tertiary" onClick={() => setLosing(null)}>
                          {t('returns.cancel')}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          busy={checkIn.isPending && checkIn.variables?.id === parcel.id}
                          onClick={() =>
                            void act(
                              async () =>
                                (await checkIn.mutateAsync({ id: parcel.id }))
                                  .fulfillmentReceiveReturn,
                            )
                          }
                        >
                          {t('returns.checkIn.this')}
                        </Button>
                        <Button variant="danger" onClick={() => setLosing(parcel.id)}>
                          {t('returns.lost.it')}
                        </Button>
                      </div>
                    ))}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {query.data.returningParcels.pageInfo.hasNextPage && (
        <p className="text-secondary">{t('returns.first')}</p>
      )}
    </>
  );
}

/**
 * Parcels coming back (COD-09, ADR-071, ADR-072, ADR-093): those on their way back, the longest
 * first, a slow courier's in red, checked in by the tracking number on their label or from the
 * list, or marked lost; the parcels couriers lost, and the claims on them. Packers check in;
 * owners, managers and accountants claim.
 */
export function ReturnsPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  const navigate = useNavigate();
  const tab: ReturnsTab = useSearch({ from: '/$shopId/returns' }).tab ?? 'back';
  const tabs = RETURNS_TABS.filter((each) => each !== 'claims' || CLAIMS.includes(role));
  const showing = tabs.includes(tab) ? tab : 'back';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Undo2 aria-hidden className="size-7 text-secondary" />
        {t('returns.title')}
      </h1>
      <div role="tablist" className="flex flex-wrap gap-2">
        {tabs.map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={showing === each}
            onClick={() =>
              void navigate({
                to: '/$shopId/returns',
                params: { shopId },
                search: each === 'back' ? {} : { tab: each },
              })
            }
            className={`min-h-10 rounded-full border px-4 ${
              showing === each ? 'border-primary bg-primary text-on-primary' : 'border-line'
            }`}
          >
            {t(`returns.tab.${each}` as MessageKey)}
          </button>
        ))}
      </div>
      {showing === 'back' ? <ComingBack /> : showing === 'lost' ? <Lost /> : <Claims />}
    </div>
  );
}
