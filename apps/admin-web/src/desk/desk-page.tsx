import { parsePkMobile } from '@hatti/pk';
import { Link } from '@tanstack/react-router';
import {
  Ban,
  Check,
  Clock,
  Eye,
  MessageCircle,
  Phone,
  PhoneMissed,
  PhoneOff,
  ShieldAlert,
} from 'lucide-react';
import { useState } from 'react';
import {
  ConfirmationQueueNextMutation,
  ConfirmationQueueQuery,
  OrderCancelMutation,
  OrderConfirmationCallMutation,
  OrderConfirmMutation,
  OrderPhoneRevealMutation,
} from '../api/operations';
import type {
  ConfirmationCallOutcome,
  ConfirmationQueueData,
  ConfirmationQueueNextData,
  DeskItem,
  OrderCancelReason,
  OrderMutationData,
  OrderPhoneRevealData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import {
  formatCount,
  formatDateTime,
  formatMoney,
  formatPhone,
  formatRelative,
} from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { REASONS } from '../orders/order-page';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

const HOUR = 3_600_000;

/** What the agent did with the order dealt to them. */
type Outcome =
  | { kind: 'confirm' }
  | { kind: 'call'; outcome: ConfirmationCallOutcome; callBackAt?: string }
  | { kind: 'cancel'; reason: OrderCancelReason };

/** The order dealt to the agent: who to call and why it matters, and what the call came to. */
function DealtOrder({
  item,
  timezone,
  onDone,
}: {
  item: DeskItem;
  timezone: string;
  /** Called once an outcome is recorded: the desk deals the next. */
  onDone: () => void;
}) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const { order } = item;
  const reveal = useAdminMutation<OrderPhoneRevealData, { id: string }>(OrderPhoneRevealMutation);
  const confirm = useAdminMutation<OrderMutationData, { id: string }>(OrderConfirmMutation);
  const call = useAdminMutation<
    OrderMutationData,
    { id: string; outcome: ConfirmationCallOutcome; note: string | null; callBackAt: string | null }
  >(OrderConfirmationCallMutation);
  const cancel = useAdminMutation<OrderMutationData, { id: string; reason: OrderCancelReason }>(
    OrderCancelMutation,
  );
  const [revealed, setRevealed] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [choosing, setChoosing] = useState<'callBack' | 'cancel' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = confirm.isPending || call.isPending || cancel.isPending;

  // Owners and managers see numbers whole; agents see them masked until they reveal one.
  const masked = order.phone?.includes('•') ?? false;
  const phone = revealed ?? (masked ? null : order.phone);
  const mobile = phone ? parsePkMobile(phone) : null;

  const onReveal = async () => {
    setProblem(null);
    try {
      const { orderPhoneReveal } = await reveal.mutateAsync({ id: order.id });
      if (orderPhoneReveal.userErrors[0]) setProblem(orderPhoneReveal.userErrors[0].message);
      else setRevealed(orderPhoneReveal.phone);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const record = async (outcome: Outcome) => {
    setProblem(null);
    try {
      const data =
        outcome.kind === 'confirm'
          ? await confirm.mutateAsync({ id: order.id })
          : outcome.kind === 'cancel'
            ? await cancel.mutateAsync({ id: order.id, reason: outcome.reason })
            : await call.mutateAsync({
                id: order.id,
                outcome: outcome.outcome,
                note: note.trim() || null,
                callBackAt: outcome.callBackAt ?? null,
              });
      const payload = Object.values(data)[0]!;
      if (payload.userErrors[0]) setProblem(payload.userErrors[0].message);
      else onDone();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const later = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <Link
            to="/$shopId/orders/$orderId"
            params={{ shopId, orderId: order.id }}
            className="num text-[length:var(--hatti-type-title-size)] font-semibold hover:underline"
          >
            {order.name}
          </Link>
          <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">
            {formatMoney(order.totalPrice.amount, order.totalPrice.currencyCode)}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 text-secondary">
          <span>
            {order.shippingAddress.city} · {formatRelative(order.createdAt, timezone, locale)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock aria-hidden className="size-4" />
            {t('desk.yours')}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-medium">
          {order.customer?.displayName ?? order.shippingAddress.name}
          {order.customer && (
            <span className="text-secondary">
              {' · '}
              {t('order.ordersBefore', { count: formatCount(order.customer.numberOfOrders) })}
            </span>
          )}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="num">{phone ? formatPhone(phone) : order.phone}</span>
          {masked && !revealed && (
            <Button
              variant="tertiary"
              icon={<Eye aria-hidden className="size-5" />}
              busy={reveal.isPending}
              onClick={() => void onReveal()}
            >
              {t('desk.revealPhone')}
            </Button>
          )}
        </div>
        {phone && (
          <div className="flex flex-wrap gap-2">
            <a
              href={`tel:${phone}`}
              className="inline-flex min-h-12 items-center gap-2 rounded-control bg-primary px-4 font-medium text-on-primary md:min-h-10"
            >
              <Phone aria-hidden className="size-5" />
              {t('desk.call')}
            </a>
            {mobile && (
              <a
                href={`https://wa.me/${mobile.e164.slice(1)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line px-4 font-medium md:min-h-10"
              >
                <MessageCircle aria-hidden className="size-5" />
                {t('desk.whatsapp')}
              </a>
            )}
          </div>
        )}
      </div>

      {(item.unansweredCalls > 0 || item.lastCall) && (
        <p className="text-secondary">
          {item.unansweredCalls > 0 && t('desk.callsMissed', { count: item.unansweredCalls })}
          {item.unansweredCalls > 0 && item.lastCall && ' · '}
          {item.lastCall &&
            t('desk.lastCall', {
              outcome: t(`desk.outcome.${item.lastCall.outcome}` as MessageKey),
              when: formatRelative(item.lastCall.createdAt, timezone, locale),
            })}
          {item.lastCall?.note ? ` · “${item.lastCall.note}”` : ''}
        </p>
      )}

      {order.risk && order.risk.reasons.length > 0 && (
        <div
          className={`flex flex-col gap-1 rounded-control border-s-4 p-3 ${
            order.risk.level === 'HIGH'
              ? 'border-danger'
              : order.risk.level === 'MEDIUM'
                ? 'border-warning'
                : 'border-line'
          }`}
        >
          <span className="inline-flex items-center gap-2 font-medium">
            <ShieldAlert aria-hidden className="size-5" />
            {t(`orders.risk.${order.risk.level}` as MessageKey)}
          </span>
          <ul className="list-disc ps-5 text-secondary">
            {order.risk.reasons.map((reason) => (
              <li key={reason.code}>{reason.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <ul>
          {order.lineItems.map((line) => (
            <li key={line.id}>
              {line.title}
              {line.variantTitle && line.variantTitle !== 'Default Title'
                ? ` · ${line.variantTitle}`
                : ''}{' '}
              <span className="num text-secondary">× {line.quantity}</span>
            </li>
          ))}
        </ul>
        <address className="not-italic text-secondary">
          {order.shippingAddress.formatted.join(', ')}
        </address>
        {Number(order.codAmount.amount) > 0 && (
          <p>
            {t('order.toCollect')}:{' '}
            <span className="num font-medium">
              {formatMoney(order.codAmount.amount, order.codAmount.currencyCode)}
            </span>
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <h2 className="font-semibold">{t('desk.outcome')}</h2>
        <label className="flex flex-col gap-1">
          <span className="text-secondary">{t('desk.note')}</span>
          <input
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
          />
        </label>
        {problem && <Alert tone="danger">{problem}</Alert>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Button
            icon={<Check aria-hidden className="size-5" />}
            busy={confirm.isPending}
            disabled={busy}
            onClick={() => void record({ kind: 'confirm' })}
          >
            {t('desk.confirmed')}
          </Button>
          <Button
            variant="secondary"
            icon={<PhoneMissed aria-hidden className="size-5" />}
            disabled={busy}
            onClick={() => void record({ kind: 'call', outcome: 'NO_ANSWER' })}
          >
            {t('desk.noAnswer')}
          </Button>
          <Button
            variant="secondary"
            icon={<Clock aria-hidden className="size-5" />}
            disabled={busy}
            aria-expanded={choosing === 'callBack'}
            onClick={() => setChoosing(choosing === 'callBack' ? null : 'callBack')}
          >
            {t('desk.callBack')}
          </Button>
          <Button
            variant="secondary"
            icon={<PhoneOff aria-hidden className="size-5" />}
            disabled={busy}
            onClick={() => void record({ kind: 'call', outcome: 'WRONG_NUMBER' })}
          >
            {t('desk.wrongNumber')}
          </Button>
        </div>
        {choosing === 'callBack' && (
          <div role="group" aria-label={t('desk.callBackIn')} className="flex flex-wrap gap-2">
            {(
              [
                ['desk.in1h', 1],
                ['desk.in3h', 3],
                ['desk.tomorrow', 24],
              ] as const
            ).map(([label, hours]) => (
              <Button
                key={label}
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void record({ kind: 'call', outcome: 'CALL_BACK', callBackAt: later(hours) })
                }
              >
                {t(label)}
              </Button>
            ))}
          </div>
        )}
        <Button
          variant="tertiary"
          icon={<Ban aria-hidden className="size-5" />}
          disabled={busy}
          aria-expanded={choosing === 'cancel'}
          onClick={() => setChoosing(choosing === 'cancel' ? null : 'cancel')}
          className="self-start text-danger"
        >
          {t('desk.cancel')}
        </Button>
        {choosing === 'cancel' && (
          <div role="group" aria-label={t('order.cancelReason')} className="flex flex-wrap gap-2">
            {REASONS.map((reason) => (
              <Button
                key={reason}
                variant="secondary"
                disabled={busy}
                onClick={() => void record({ kind: 'cancel', reason })}
              >
                {t(`order.reason.${reason}` as MessageKey)}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * The Confirmation Desk (COD-04, docs/design/03 F3): the order due a call dealt to the agent, one
 * at a time and no two agents on one customer; the customer's number shown when they call, which
 * is logged; one tap for how the call went, and the next order dealt at once. Below it, every
 * order due now, the most urgent first.
 */
export function DeskPage() {
  const { t, locale } = useLocale();
  const queue = useAdminQuery<ConfirmationQueueData>(
    ['confirmationQueue'],
    ConfirmationQueueQuery,
    {
      first: 50,
    },
  );
  const next = useAdminMutation<ConfirmationQueueNextData, Record<string, never>>(
    ConfirmationQueueNextMutation,
  );
  const [dealt, setDealt] = useState<DeskItem | null>(null);
  /** Orders whose call is recorded, which the queue may still say are held until it is read again. */
  const [finished, setFinished] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);

  const deal = async () => {
    setProblem(null);
    try {
      const { confirmationQueueNext } = await next.mutateAsync({});
      setDealt(confirmationQueueNext.item);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  if (queue.isPending) return <Loading label={t('state.loading')} />;
  if (queue.isError) {
    return (
      <ErrorState
        message={errorText(queue.error, t)}
        action={<Button onClick={() => void queue.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }

  const { confirmationQueue: desk, shop } = queue.data;
  const held = desk.nodes.find((item) => item.claimedByYou && !finished.has(item.order.id)) ?? null;
  const current = dealt && dealt.order.id !== held?.order.id ? dealt : held;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('desk.title')}
        </h1>
        <p className="text-secondary">
          {t('desk.due', { count: formatCount(desk.dueCount) })}
          {desk.overdueCount > 0 &&
            ` · ${t('desk.overdue', { count: formatCount(desk.overdueCount) })}`}
          {desk.laterCount > 0 && ` · ${t('desk.later', { count: formatCount(desk.laterCount) })}`}
        </p>
      </header>

      {!desk.callingNow && desk.callingOpensAt && (
        <Alert tone="info">
          {t('desk.closed', { time: formatDateTime(desk.callingOpensAt, shop.timezone, locale) })}
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}

      {current ? (
        <DealtOrder
          key={current.order.id}
          item={current}
          timezone={shop.timezone}
          onDone={() => {
            setFinished((done) => new Set(done).add(current.order.id));
            setDealt(null);
            void deal();
          }}
        />
      ) : desk.callingNow && desk.dueCount > 0 ? (
        <Button busy={next.isPending} onClick={() => void deal()} className="self-start">
          {t('desk.start')}
        </Button>
      ) : (
        <Card>
          <EmptyState title={t('desk.empty')} body={t('desk.emptyBody')} />
        </Card>
      )}

      {desk.nodes.length > 0 && (
        <section aria-labelledby="desk-queue" className="flex flex-col gap-2">
          <h2 id="desk-queue" className="font-semibold">
            {t('desk.queue')}
          </h2>
          <Card>
            <ul className="divide-y divide-line">
              {desk.nodes
                .filter((item) => !finished.has(item.order.id))
                .map((item) => (
                  <li key={item.order.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="num font-semibold">{item.order.name}</span>
                    <span className="min-w-0 flex-1 truncate text-secondary">
                      {item.order.customer?.displayName ?? item.order.shippingAddress.name} ·{' '}
                      {item.order.shippingAddress.city}
                    </span>
                    {item.overdue && (
                      <span className="text-warning text-[length:var(--hatti-type-body-sm-size)]">
                        {t('desk.overdueBadge')}
                      </span>
                    )}
                    {item.claimedUntil && !item.claimedByYou && (
                      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                        {t('desk.taken')}
                      </span>
                    )}
                    <span className="num">
                      {formatMoney(
                        item.order.totalPrice.amount,
                        item.order.totalPrice.currencyCode,
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          </Card>
        </section>
      )}
    </div>
  );
}
