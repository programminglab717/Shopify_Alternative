import type { OrderStage as BadgeColour } from '@hatti/tokens';
import type { LucideIcon } from 'lucide-react';
import { CircleAlert, CircleCheck, CircleMinus, CircleX, Clock, PackageSearch } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  LostParcelsQuery,
  ParcelClaimCreateMutation,
  ParcelClaimSettleMutation,
  ParcelClaimsQuery,
} from '../api/operations';
import type {
  FulfillmentClaimStatus,
  LostParcelsData,
  MoneyValue,
  ParcelClaimsData,
  ParcelClaimValue,
  ParcelUserErrorsData,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { parsePrice, priceText, problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CLAIMS, ParcelTitle } from './parcel';

/** How a claim's state shows: open amber, paid green, refused red, withdrawn grey. */
const CLAIM_BADGES: Record<
  FulfillmentClaimStatus | 'UNCLAIMED',
  { colour: BadgeColour; icon: LucideIcon }
> = {
  UNCLAIMED: { colour: 'needsConfirmation', icon: CircleAlert },
  OPEN: { colour: 'needsConfirmation', icon: Clock },
  PAID: { colour: 'delivered', icon: CircleCheck },
  REFUSED: { colour: 'deliveryIssue', icon: CircleX },
  WITHDRAWN: { colour: 'cancelled', icon: CircleMinus },
};

function ClaimBadge({ claim }: { claim: ParcelClaimValue | null }) {
  const { t } = useLocale();
  const status = claim?.status ?? 'UNCLAIMED';
  const badge = CLAIM_BADGES[status];
  return (
    <Badge
      colour={badge.colour}
      icon={badge.icon}
      label={t(`returns.claim.${status}` as MessageKey)}
    />
  );
}

/** A claim's amount, what was paid on it, and the shop's note, as one line. */
function ClaimLine({ claim }: { claim: ParcelClaimValue }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  return (
    <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
      {t('returns.claim.line', {
        amount: formatMoney(claim.amount.amount),
        date: formatDate(claim.claimedAt, timezone, locale),
      })}
      {claim.paid && ` · ${t('returns.claim.paidLine', { paid: formatMoney(claim.paid.amount) })}`}
      {claim.note && (
        <>
          {' · '}
          <span dir="auto">{claim.note}</span>
        </>
      )}
    </span>
  );
}

type Run = () => Promise<{ userErrors: UserError[] }>;

/** Runs a claim's mutation, saying why it was refused; true when it went through. */
function useAttempt() {
  const { t } = useLocale();
  const [problem, setProblem] = useState<string | null>(null);
  const attempt = async (run: Run): Promise<boolean> => {
    setProblem(null);
    try {
      const result = await run();
      if (result.userErrors.length > 0) {
        setProblem(result.userErrors.map((error) => problemText(error, t)).join(' '));
        return false;
      }
      return true;
    } catch (failure) {
      setProblem(errorText(failure, t));
      return false;
    }
  };
  return { problem, attempt };
}

/** A claim filed for a lost parcel: its worth unless the shop says less, and the claim number. */
function ClaimForm({ id, worth, onDone }: { id: string; worth: MoneyValue; onDone: () => void }) {
  const { t } = useLocale();
  const [amount, setAmount] = useState(priceText(worth.amount));
  const [note, setNote] = useState('');
  const create = useAdminMutation<
    ParcelUserErrorsData,
    { id: string; amount: string; note: string | null }
  >(ParcelClaimCreateMutation);
  const { problem, attempt } = useAttempt();
  const parsed = parsePrice(amount);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsed) return;
    const done = await attempt(
      async () =>
        (await create.mutateAsync({ id, amount: parsed, note: note.trim() || null }))
          .fulfillmentClaimCreate!,
    );
    if (done) onDone();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-2">
        <TextField
          label={t('returns.claim.amount')}
          inputMode="decimal"
          ltr
          value={amount}
          error={amount && !parsed ? t('returns.claim.amountWrong') : null}
          onChange={(event) => setAmount(event.target.value)}
        />
        <TextField
          label={t('returns.claim.note')}
          hint={t('returns.claim.noteHint')}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={create.isPending} disabled={!parsed}>
          {t('returns.claim.file')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Lost parcels, the longest lost first, each with its worth and its claim, or none yet. */
export function Lost() {
  const { t } = useLocale();
  const { role } = useShop();
  const query = useAdminQuery<LostParcelsData>(['lostParcels'], LostParcelsQuery);
  const [claiming, setClaiming] = useState<string | null>(null);
  const claims = CLAIMS.includes(role);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const parcels = query.data.lostParcels.nodes;
  if (parcels.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<PackageSearch aria-hidden className="size-8 text-success" />}
          title={t('returns.lost.none')}
        />
      </Card>
    );
  }

  return (
    <Card>
      <ul className="divide-y divide-line">
        {parcels.map((parcel) => {
          // A claim withdrawn may be filed again.
          const claimable = !parcel.claim || parcel.claim.status === 'WITHDRAWN';
          return (
            <li key={parcel.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-start gap-3">
                <ParcelTitle
                  orderId={parcel.orderId}
                  orderName={parcel.orderName}
                  tracking={parcel.trackingInfo}
                />
                <span className="flex flex-col items-end gap-1">
                  <span className="num font-medium">{formatMoney(parcel.worth.amount)}</span>
                  <ClaimBadge claim={parcel.claim} />
                </span>
              </div>
              <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {parcel.days === 0
                  ? t('returns.lost.today')
                  : t('returns.lost.days', { count: formatCount(parcel.days) })}{' '}
                · {t('returns.items', { count: formatCount(parcel.units) })}
              </span>
              {parcel.claim && <ClaimLine claim={parcel.claim} />}
              {claims &&
                claimable &&
                (claiming === parcel.id ? (
                  <ClaimForm id={parcel.id} worth={parcel.worth} onDone={() => setClaiming(null)} />
                ) : (
                  <Button
                    variant="secondary"
                    className="self-start"
                    onClick={() => setClaiming(parcel.id)}
                  >
                    {t('returns.claim.start')}
                  </Button>
                ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

type Settlement = 'PAID' | 'REFUSED' | 'WITHDRAWN';

/** What became of a claim: paid otherwise than in a statement, refused with why, or withdrawn. */
function SettleForm({
  id,
  claim,
  onDone,
}: {
  id: string;
  claim: ParcelClaimValue;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [status, setStatus] = useState<Settlement>('PAID');
  const [amount, setAmount] = useState(priceText(claim.amount.amount));
  const [note, setNote] = useState('');
  const settle = useAdminMutation<
    ParcelUserErrorsData,
    { id: string; status: Settlement; amount: string | null; note: string | null }
  >(ParcelClaimSettleMutation);
  const { problem, attempt } = useAttempt();
  const parsed = parsePrice(amount);
  const ready = status !== 'PAID' || parsed !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const done = await attempt(
      async () =>
        (
          await settle.mutateAsync({
            id,
            status,
            amount: status === 'PAID' ? parsed : null,
            note: note.trim() || null,
          })
        ).fulfillmentClaimSettle!,
    );
    if (done) onDone();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-3">
        <SelectField<Settlement>
          label={t('returns.settle.what')}
          value={status}
          options={(['PAID', 'REFUSED', 'WITHDRAWN'] as const).map((each) => ({
            value: each,
            label: t(`returns.settle.${each}` as MessageKey),
          }))}
          onChange={setStatus}
        />
        {status === 'PAID' && (
          <TextField
            label={t('returns.settle.amount')}
            inputMode="decimal"
            ltr
            value={amount}
            error={amount && !parsed ? t('returns.claim.amountWrong') : null}
            onChange={(event) => setAmount(event.target.value)}
          />
        )}
        <TextField
          label={t(status === 'REFUSED' ? 'returns.settle.why' : 'returns.claim.note')}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={settle.isPending} disabled={!ready}>
          {t('returns.settle.save')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

const TO_FOLLOW: FulfillmentClaimStatus[] = ['OPEN', 'REFUSED'];

/** Claims on couriers, the oldest first: those open or refused to follow up, or all of them. */
export function Claims() {
  const { t } = useLocale();
  const [all, setAll] = useState(false);
  const [settling, setSettling] = useState<string | null>(null);
  const query = useAdminQuery<ParcelClaimsData>(['parcelClaims', all], ParcelClaimsQuery, {
    status: all ? null : TO_FOLLOW,
  });

  return (
    <>
      <label className="flex min-h-10 items-center gap-2 self-start">
        <input
          type="checkbox"
          checked={all}
          onChange={(event) => setAll(event.target.checked)}
          className="size-5 accent-[var(--hatti-color-primary)]"
        />
        {t('returns.claims.all')}
      </label>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState message={errorText(query.error, t)} />
      ) : query.data.parcelClaims.nodes.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CircleCheck aria-hidden className="size-8 text-success" />}
            title={t(all ? 'returns.claims.none' : 'returns.claims.noneToFollow')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.parcelClaims.nodes.map((parcel) => (
              <li key={parcel.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start gap-3">
                  <ParcelTitle
                    orderId={parcel.orderId}
                    orderName={parcel.orderName}
                    tracking={parcel.trackingInfo}
                  />
                  <span className="flex flex-col items-end gap-1">
                    <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                      {t(
                        parcel.status === 'LOST' ? 'returns.claims.lost' : 'returns.claims.damaged',
                      )}
                    </span>
                    <ClaimBadge claim={parcel.claim} />
                  </span>
                </div>
                <ClaimLine claim={parcel.claim} />
                {TO_FOLLOW.includes(parcel.claim.status) &&
                  (settling === parcel.id ? (
                    <SettleForm
                      id={parcel.id}
                      claim={parcel.claim}
                      onDone={() => setSettling(null)}
                    />
                  ) : (
                    <Button
                      variant="secondary"
                      className="self-start"
                      onClick={() => setSettling(parcel.id)}
                    >
                      {t('returns.settle')}
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
