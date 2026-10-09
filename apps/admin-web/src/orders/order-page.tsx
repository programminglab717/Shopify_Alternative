import { Link, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Ban,
  Check,
  EyeOff,
  PackageCheck,
  PackageOpen,
  ShieldAlert,
  Truck,
} from 'lucide-react';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import {
  OrderCancelMutation,
  OrderConfirmMutation,
  OrderMarkPackedMutation,
  OrderMarkUnpackedMutation,
  OrderQuery,
} from '../api/operations';
import type {
  OrderCancelReason,
  OrderData,
  OrderDetail,
  OrderMutationData,
  OrderStage,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDateTime, formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { READS_CUSTOMERS } from '../customers/customers-page';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { OrderMessages } from '../settings/messages-page';
import { Assignment, DeliveryAddress, NoteAndTags, Timeline } from './details';
import { OrderItems } from './edit-order';
import { HANDLES_MONEY, OrderMoney } from './money';
import { Parcels, ShipForm, WORKS_PARCELS } from './parcels';
import { OrderReturns } from './returns';
import { StageBadge } from './stage';

const CONFIRMABLE: readonly OrderStage[] = ['NEEDS_CONFIRMATION', 'NEEDS_REVIEW'];
const CANCELLABLE: readonly OrderStage[] = [
  'NEEDS_CONFIRMATION',
  'NEEDS_REVIEW',
  'AWAITING_PAYMENT',
  'TO_PACK',
  'TO_BOOK',
];
/** The reasons staff cancel for; MERGED is the merge's own. */
export const REASONS: readonly OrderCancelReason[] = [
  'CUSTOMER',
  'NO_RESPONSE',
  'FRAUD',
  'INVENTORY',
  'UNPAID',
  'OTHER',
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card className="p-4">
      <section aria-labelledby={id} className="flex flex-col gap-3">
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        {children}
      </section>
    </Card>
  );
}

/** Where what is left of an order may be shipped by hand: packed, or partly shipped already. */
const SHIPPABLE: readonly OrderStage[] = ['TO_BOOK', 'PARTIALLY_FULFILLED'];

/**
 * The order's actions for its stage, for those who work orders: confirm, pack, unpack while
 * nothing has shipped, ship by hand with a courier Hatti does not book with, or cancel for a
 * reason.
 */
function Actions({ order }: { order: OrderDetail }) {
  const { t } = useLocale();
  const { role } = useShop();
  const confirm = useAdminMutation<OrderMutationData, { id: string }>(OrderConfirmMutation);
  const pack = useAdminMutation<OrderMutationData, { id: string }>(OrderMarkPackedMutation);
  const unpack = useAdminMutation<OrderMutationData, { id: string }>(OrderMarkUnpackedMutation);
  const cancel = useAdminMutation<OrderMutationData, { id: string; reason: OrderCancelReason }>(
    OrderCancelMutation,
  );
  const [cancelling, setCancelling] = useState(false);
  const [shipping, setShipping] = useState(false);
  const [reason, setReason] = useState<OrderCancelReason>('CUSTOMER');
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (action: () => Promise<OrderMutationData>) => {
    setProblem(null);
    try {
      const payload = Object.values(await action())[0]!;
      if (payload.userErrors.length > 0) setProblem(payload.userErrors[0]!.message);
      else setCancelling(false);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const open = order.status === 'OPEN' && WORKS_PARCELS.includes(role);
  const canConfirm = open && !order.overPlanLimit && CONFIRMABLE.includes(order.stage);
  const canPack = open && !order.overPlanLimit && order.stage === 'TO_PACK';
  const canUnpack = open && order.stage === 'TO_BOOK' && order.fulfillments.length === 0;
  const canShip = open && !order.overPlanLimit && SHIPPABLE.includes(order.stage);
  const canCancel = open && CANCELLABLE.includes(order.stage);
  if (!canConfirm && !canPack && !canUnpack && !canShip && !canCancel) return null;

  return (
    <div className="flex flex-col gap-3">
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        {canConfirm && (
          <Button
            icon={<Check aria-hidden className="size-5" />}
            busy={confirm.isPending}
            onClick={() => void run(() => confirm.mutateAsync({ id: order.id }))}
          >
            {t('order.confirm')}
          </Button>
        )}
        {canPack && (
          <Button
            icon={<PackageCheck aria-hidden className="size-5" />}
            busy={pack.isPending}
            onClick={() => void run(() => pack.mutateAsync({ id: order.id }))}
          >
            {t('order.pack')}
          </Button>
        )}
        {canUnpack && (
          <Button
            variant="secondary"
            icon={<PackageOpen aria-hidden className="size-5" />}
            busy={unpack.isPending}
            onClick={() => void run(() => unpack.mutateAsync({ id: order.id }))}
          >
            {t('order.unpack')}
          </Button>
        )}
        {canShip && !shipping && (
          <Button
            variant="secondary"
            icon={<Truck aria-hidden className="size-5" />}
            onClick={() => {
              setShipping(true);
              setCancelling(false);
            }}
          >
            {t('parcels.ship')}
          </Button>
        )}
        {canCancel && !cancelling && (
          <Button
            variant="secondary"
            icon={<Ban aria-hidden className="size-5" />}
            onClick={() => {
              setCancelling(true);
              setShipping(false);
            }}
          >
            {t('order.cancel')}
          </Button>
        )}
      </div>
      {shipping && canShip && <ShipForm order={order} onDone={() => setShipping(false)} />}
      {cancelling && (
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="font-semibold">{t('order.cancelTitle', { name: order.name })}</h2>
          <p className="text-secondary">{t('order.cancelBody')}</p>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-medium">{t('order.cancelReason')}</legend>
            {REASONS.map((each) => (
              <label key={each} className="flex min-h-10 items-center gap-2">
                <input
                  type="radio"
                  name="reason"
                  value={each}
                  checked={reason === each}
                  onChange={() => setReason(each)}
                  className="size-5 accent-[var(--hatti-color-primary)]"
                />
                {t(`order.reason.${each}` as MessageKey)}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={cancel.isPending}
              onClick={() => void run(() => cancel.mutateAsync({ id: order.id, reason }))}
            >
              {t('order.cancelSubmit')}
            </Button>
            <Button variant="secondary" onClick={() => setCancelling(false)}>
              {t('order.cancelKeep')}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * An order's page (ORD-02): its stage and what can be done next, its items and totals, changed
 * while it waits to be packed (ORD-04), the cash to collect, its customer and address (hidden past the plan's limit, ADR-263), why it is risky,
 * and its timeline.
 */
export function OrderPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const { orderId } = useParams({ from: '/$shopId/orders/$orderId' });
  const query = useAdminQuery<OrderData>(['order', orderId], OrderQuery, { id: orderId });

  const back = (
    <Link
      to="/$shopId/orders"
      params={{ shopId: shop.id }}
      className="inline-flex min-h-10 items-center gap-1 text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('order.back')}
    </Link>
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { order, shop: details } = query.data;
  if (!order) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {back}
        <EmptyState title={t('order.notFound')} />
      </div>
    );
  }
  const timezone = details.timezone;
  const phone = order.shippingAddress.phone ?? order.phone;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      {back}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="num text-[length:var(--hatti-type-display-size)] font-semibold">
            {order.name}
          </h1>
          <StageBadge stage={order.stage} />
        </div>
        <p className="text-secondary">
          {t('order.placed', { date: formatDateTime(order.createdAt, timezone, locale) })} ·{' '}
          {t(`order.payment.${order.paymentMethod}` as MessageKey)}
          {order.assignee ? ` · ${t('order.assignee', { name: order.assignee.name })}` : ''}
        </p>
        {order.cancelReason && (
          <p className="text-secondary">
            {t('order.cancelledBecause', {
              reason: t(`order.reason.${order.cancelReason}` as MessageKey),
            })}
          </p>
        )}
        {[
          { key: 'order.mergedInto' as const, other: order.mergedInto },
          { key: 'order.splitFrom' as const, other: order.splitFrom },
        ].map(
          ({ key, other }) =>
            other && (
              <p key={key} className="text-secondary">
                {t(key)}{' '}
                <Link
                  to="/$shopId/orders/$orderId"
                  params={{ shopId: shop.id, orderId: other.id }}
                  className="num font-medium text-primary hover:underline"
                >
                  {other.name}
                </Link>
              </p>
            ),
        )}
      </header>
      {order.overPlanLimit && <Alert tone="warning">{t('order.overLimit')}</Alert>}
      <Actions order={order} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Section title={t('order.items')}>
            <OrderItems order={order} />
          </Section>
          {(HANDLES_MONEY.includes(shop.role) ||
            Number(order.amountPaid.amount) > 0 ||
            order.refunds.length > 0) && (
            <Section title={t('money.title')}>
              <OrderMoney order={order} timezone={timezone} />
            </Section>
          )}
          {order.fulfillments.length > 0 && (
            <Section title={t('parcels.title')}>
              <Parcels parcels={order.fulfillments} timezone={timezone} />
            </Section>
          )}
          {(order.returns.length > 0 ||
            order.fulfillments.some((parcel) => parcel.status === 'DELIVERED')) && (
            <Section title={t('orderReturns.title')}>
              <OrderReturns order={order} timezone={timezone} />
            </Section>
          )}
          <Section title={t('order.timeline')}>
            <Timeline order={order} timezone={timezone} />
          </Section>
          <Section title={t('messages.sentForOrder')}>
            <OrderMessages orderId={order.id} />
          </Section>
        </div>
        <div className="flex flex-col gap-4">
          <Section title={t('details.assigneeTitle')}>
            <Assignment order={order} />
          </Section>
          <Section title={t('order.customer')}>
            {order.overPlanLimit ? (
              <p className="flex items-center gap-2 text-secondary">
                <EyeOff aria-hidden className="size-5" />
                {t('orders.hidden')}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {order.customer && READS_CUSTOMERS.includes(shop.role) ? (
                  <Link
                    to="/$shopId/customers/$customerId"
                    params={{ shopId: shop.id, customerId: order.customer.id }}
                    className="font-medium text-primary hover:underline"
                  >
                    {order.customer.displayName}
                  </Link>
                ) : (
                  <span className="font-medium">
                    {order.customer?.displayName ?? order.shippingAddress.name}
                  </span>
                )}
                {phone && (
                  <a href={`tel:${phone}`} className="num text-primary">
                    {formatPhone(phone)}
                  </a>
                )}
                {order.customer && (
                  <span className="text-secondary">
                    {t('order.ordersBefore', { count: formatCount(order.customer.numberOfOrders) })}
                  </span>
                )}
              </div>
            )}
          </Section>
          <Section title={t('order.address')}>
            <DeliveryAddress order={order} />
          </Section>
          <Section title={t('details.noteAndTags')}>
            <NoteAndTags order={order} />
          </Section>
          {order.risk && order.risk.reasons.length > 0 && (
            <Section title={t('order.risk')}>
              <p
                className={`flex items-center gap-2 font-medium ${
                  order.risk.level === 'HIGH'
                    ? 'text-danger'
                    : order.risk.level === 'MEDIUM'
                      ? 'text-warning'
                      : 'text-success'
                }`}
              >
                <ShieldAlert aria-hidden className="size-5" />
                {t(`orders.risk.${order.risk.level}` as MessageKey)} ·{' '}
                {t('order.riskScore', { score: Math.round(order.risk.score * 100) })}
              </p>
              <ul className="list-disc ps-5 text-secondary">
                {order.risk.reasons.map((reason) => (
                  <li key={reason.code}>{reason.message}</li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
