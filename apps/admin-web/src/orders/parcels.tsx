import type { OrderStage as BadgeColour } from '@hatti/tokens';
import type { LucideIcon } from 'lucide-react';
import { PackageCheck, PackageX, Truck, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ParcelClaimCreateMutation,
  ParcelEventCreateMutation,
  ParcelMarkDeliveredMutation,
  ParcelMarkLostMutation,
  ParcelMarkReturningMutation,
  ParcelReceiveMutation,
} from '../api/operations';
import type {
  FulfillmentEventStatus,
  FulfillmentStatus,
  ParcelDetail,
  ParcelUserErrorsData,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { formatCount, formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { CLAIMS, trackingText, useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { parsePrice } from '../products/product-form';
import { useAdminMutation, useShop } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { RestockForm } from './restock-form';
import type { Restock } from './restock-form';

/** Those who move a parcel along, as the core lets them (`write_orders`). */
export const WORKS_PARCELS: readonly StaffRole[] = [
  'owner',
  'manager',
  'confirmation_agent',
  'packer',
];

/** Steps shown before "all steps": the latest few are what staff look for. */
const FIRST_STEPS = 3;

const STATUS_BADGES: Record<FulfillmentStatus, { colour: BadgeColour; icon: LucideIcon }> = {
  IN_TRANSIT: { colour: 'inTransit', icon: Truck },
  DELIVERED: { colour: 'delivered', icon: PackageCheck },
  RETURNING: { colour: 'deliveryIssue', icon: Undo2 },
  RETURNED: { colour: 'returned', icon: Undo2 },
  LOST: { colour: 'deliveryIssue', icon: PackageX },
};

/** The steps staff record for a courier Hatti does not follow; the rest have actions of their own. */
const STEPS: readonly FulfillmentEventStatus[] = [
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'ATTEMPTED_DELIVERY',
];

type Run = () => Promise<ParcelUserErrorsData>;

/** A step of the parcel's way told of its courier: what happened, and its words. */
function StepForm({ id, onDone }: { id: string; onDone: () => void }) {
  const { t } = useLocale();
  const [status, setStatus] = useState<FulfillmentEventStatus>('OUT_FOR_DELIVERY');
  const [message, setMessage] = useState('');
  const create = useAdminMutation<ParcelUserErrorsData, Record<string, unknown>>(
    ParcelEventCreateMutation,
  );
  const { problem, attempt } = useAttempt();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const done = await attempt(
      async () =>
        (
          await create.mutateAsync({
            fulfillmentEvent: { fulfillmentId: id, status, message: message.trim() || null },
          })
        ).fulfillmentEventCreate!,
    );
    if (done) onDone();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-2">
        <SelectField<FulfillmentEventStatus>
          label={t('parcels.step.what')}
          value={status}
          options={STEPS.map((each) => ({
            value: each,
            label: t(`parcels.event.${each}` as MessageKey),
          }))}
          onChange={setStatus}
        />
        <TextField
          label={t('parcels.step.message')}
          hint={t('parcels.step.messageHint')}
          value={message}
          maxLength={200}
          onChange={(event) => setMessage(event.target.value)}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={create.isPending}>
          {t('parcels.step.save')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** A parcel that came back checked in: how many of each line go back in stock, the rest written off. */
function CheckInForm({ parcel, onDone }: { parcel: ParcelDetail; onDone: () => void }) {
  const receive = useAdminMutation<ParcelUserErrorsData, { id: string; restock: Restock }>(
    ParcelReceiveMutation,
  );
  const { problem, attempt } = useAttempt();
  return (
    <RestockForm
      lines={parcel.fulfillmentLineItems.map((each) => ({
        ...each.lineItem,
        quantity: each.quantity,
      }))}
      busy={receive.isPending}
      problem={problem}
      onCancel={onDone}
      onSubmit={(restock) =>
        void attempt(
          async () =>
            (await receive.mutateAsync({ id: parcel.id, restock })).fulfillmentReceiveReturn!,
        ).then((done) => done && onDone())
      }
    />
  );
}

/**
 * A claim on the courier for what of a parcel that came back was written off as damaged
 * (ADR-098): that worth unless the shop says less, and the courier's claim number.
 */
function DamageClaimForm({ id, onDone }: { id: string; onDone: () => void }) {
  const { t } = useLocale();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const create = useAdminMutation<ParcelUserErrorsData, Record<string, unknown>>(
    ParcelClaimCreateMutation,
  );
  const { problem, attempt } = useAttempt();
  const parsed = amount.trim() ? parsePrice(amount) : null;
  const ready = !amount.trim() || parsed !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
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
          hint={t('parcels.damage.amountHint')}
          inputMode="decimal"
          ltr
          value={amount}
          error={ready ? null : t('returns.claim.amountWrong')}
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
        <Button type="submit" busy={create.isPending} disabled={!ready}>
          {t('returns.claim.file')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

type Open = 'step' | 'checkIn' | 'lost' | 'claim' | null;

function Parcel({ parcel, timezone }: { parcel: ParcelDetail; timezone: string }) {
  const { t, locale } = useLocale();
  const { role } = useShop();
  const [open, setOpen] = useState<Open>(null);
  const [allSteps, setAllSteps] = useState(false);
  const delivered = useAdminMutation<ParcelUserErrorsData, { id: string }>(
    ParcelMarkDeliveredMutation,
  );
  const returning = useAdminMutation<ParcelUserErrorsData, { id: string }>(
    ParcelMarkReturningMutation,
  );
  const lost = useAdminMutation<ParcelUserErrorsData, { id: string }>(ParcelMarkLostMutation);
  const { problem, attempt } = useAttempt();
  const works = WORKS_PARCELS.includes(role);
  // A parcel back with items written off is claimed from its courier; a claim withdrawn, again.
  const claimable =
    CLAIMS.includes(role) &&
    parcel.status === 'RETURNED' &&
    (!parcel.claim || parcel.claim.status === 'WITHDRAWN');
  const badge = STATUS_BADGES[parcel.status];
  const steps = parcel.events.nodes;
  const shown = allSteps ? steps : steps.slice(0, FIRST_STEPS);
  const tracking = trackingText(parcel.trackingInfo);

  const run = async (go: Run, field: string) => {
    if (await attempt(async () => (await go())[field]!)) setOpen(null);
  };

  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="num min-w-0 flex-1 font-medium" dir="ltr">
          {parcel.trackingInfo.url ? (
            <a
              href={parcel.trackingInfo.url}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {tracking || t('parcels.noTracking')}
            </a>
          ) : (
            tracking || t('parcels.noTracking')
          )}
        </span>
        <Badge
          colour={badge.colour}
          icon={badge.icon}
          label={t(`stage.${parcel.status}` as MessageKey)}
        />
      </div>
      <ul className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {parcel.fulfillmentLineItems.map((each) => (
          <li key={each.lineItem.id} dir="auto">
            {formatCount(each.quantity)} × {each.lineItem.title}
            {each.lineItem.variantTitle && each.lineItem.variantTitle !== 'Default Title'
              ? ` (${each.lineItem.variantTitle})`
              : ''}
          </li>
        ))}
      </ul>
      {steps.length > 0 && (
        <ol className="flex flex-col gap-2 border-s-2 border-line ps-3">
          {shown.map((step) => (
            <li key={step.id} className="flex flex-col">
              <span className="font-medium">{t(`parcels.event.${step.status}` as MessageKey)}</span>
              {step.message && (
                <span className="text-secondary" dir="auto">
                  {step.message}
                </span>
              )}
              <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {formatDateTime(step.happenedAt, timezone, locale)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {steps.length > FIRST_STEPS && (
        <Button variant="tertiary" className="self-start" onClick={() => setAllSteps(!allSteps)}>
          {allSteps
            ? t('parcels.fewerSteps')
            : t('parcels.allSteps', { count: formatCount(steps.length) })}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {works && open === 'step' && <StepForm id={parcel.id} onDone={() => setOpen(null)} />}
      {works && open === 'checkIn' && <CheckInForm parcel={parcel} onDone={() => setOpen(null)} />}
      {works && open === 'lost' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1">{t('returns.lost.confirm')}</span>
          <Button
            variant="destructive"
            busy={lost.isPending}
            onClick={() =>
              void run(() => lost.mutateAsync({ id: parcel.id }), 'fulfillmentMarkLost')
            }
          >
            {t('returns.lost.mark')}
          </Button>
          <Button variant="tertiary" onClick={() => setOpen(null)}>
            {t('returns.cancel')}
          </Button>
        </div>
      )}
      {parcel.claim && (
        <span className="text-secondary">
          {t(`returns.claim.${parcel.claim.status}` as MessageKey)}
        </span>
      )}
      {open === 'claim' && <DamageClaimForm id={parcel.id} onDone={() => setOpen(null)} />}
      {claimable && open === null && (
        <Button variant="secondary" className="self-start" onClick={() => setOpen('claim')}>
          {t('parcels.damage.claim')}
        </Button>
      )}
      {works && open === null && (
        <div className="flex flex-wrap gap-2">
          {parcel.status === 'IN_TRANSIT' && (
            <>
              <Button
                busy={delivered.isPending}
                onClick={() =>
                  void run(
                    () => delivered.mutateAsync({ id: parcel.id }),
                    'fulfillmentMarkDelivered',
                  )
                }
              >
                {t('parcels.delivered')}
              </Button>
              <Button
                variant="secondary"
                busy={returning.isPending}
                onClick={() =>
                  void run(
                    () => returning.mutateAsync({ id: parcel.id }),
                    'fulfillmentMarkReturning',
                  )
                }
              >
                {t('parcels.refused')}
              </Button>
              <Button variant="tertiary" onClick={() => setOpen('step')}>
                {t('parcels.step')}
              </Button>
            </>
          )}
          {(parcel.status === 'RETURNING' || parcel.status === 'LOST') && (
            <Button onClick={() => setOpen('checkIn')}>
              {t(parcel.status === 'LOST' ? 'parcels.turnedUp' : 'parcels.checkIn')}
            </Button>
          )}
          {(parcel.status === 'IN_TRANSIT' || parcel.status === 'RETURNING') && (
            <Button variant="danger" onClick={() => setOpen('lost')}>
              {t('returns.lost.it')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * An order's parcels (SHP-04, ADR-160, ADR-071, ADR-072): each with its courier and tracking
 * number, its items and the latest steps of its way; moved along by those who work orders:
 * delivered, refused, a step told of a courier Hatti does not follow, lost after asking, or
 * checked back in with what is damaged written off.
 */
export function Parcels({ parcels, timezone }: { parcels: ParcelDetail[]; timezone: string }) {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {parcels.map((parcel) => (
        <Parcel key={parcel.id} parcel={parcel} timezone={timezone} />
      ))}
    </ul>
  );
}
