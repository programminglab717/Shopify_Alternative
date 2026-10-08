import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Ban, Check, EyeOff, PackageCheck, ShieldAlert } from 'lucide-react';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import {
  OrderCancelMutation,
  OrderConfirmMutation,
  OrderMarkPackedMutation,
  OrderQuery,
} from '../api/operations';
import type {
  MoneyValue,
  OrderCancelReason,
  OrderData,
  OrderDetail,
  OrderMutationData,
  OrderStage,
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
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
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
const REASONS: readonly OrderCancelReason[] = [
  'CUSTOMER',
  'NO_RESPONSE',
  'FRAUD',
  'INVENTORY',
  'UNPAID',
  'OTHER',
];

function money(value: MoneyValue): string {
  return formatMoney(value.amount, value.currencyCode);
}

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

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'font-semibold' : ''}`}>
      <dt className={strong ? '' : 'text-secondary'}>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

/** The order's actions for its stage: confirm, pack, or cancel for a reason. */
function Actions({ order }: { order: OrderDetail }) {
  const { t } = useLocale();
  const confirm = useAdminMutation<OrderMutationData, { id: string }>(OrderConfirmMutation);
  const pack = useAdminMutation<OrderMutationData, { id: string }>(OrderMarkPackedMutation);
  const cancel = useAdminMutation<OrderMutationData, { id: string; reason: OrderCancelReason }>(
    OrderCancelMutation,
  );
  const [cancelling, setCancelling] = useState(false);
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

  const open = order.status === 'OPEN';
  const canConfirm = open && !order.overPlanLimit && CONFIRMABLE.includes(order.stage);
  const canPack = open && !order.overPlanLimit && order.stage === 'TO_PACK';
  const canCancel = open && CANCELLABLE.includes(order.stage);
  if (!canConfirm && !canPack && !canCancel) return null;

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
        {canCancel && !cancelling && (
          <Button
            variant="secondary"
            icon={<Ban aria-hidden className="size-5" />}
            onClick={() => setCancelling(true)}
          >
            {t('order.cancel')}
          </Button>
        )}
      </div>
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
 * An order's page (ORD-02): its stage and what can be done next, its items and totals, the cash
 * to collect, its customer and address (hidden past the plan's limit, ADR-263), why it is risky,
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
  const discounted = Number(order.totalDiscounts.amount) > 0;
  const fee = Number(order.codFee.amount) > 0;
  const toCollect = Number(order.codAmount.amount) > 0;
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
      </header>
      {order.overPlanLimit && <Alert tone="warning">{t('order.overLimit')}</Alert>}
      <Actions order={order} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Section title={t('order.items')}>
            <ul className="divide-y divide-line">
              {order.lineItems.map((line) => (
                <li key={line.id} className="flex justify-between gap-4 py-2">
                  <span className="flex flex-col">
                    <span className="font-medium">{line.title}</span>
                    {line.variantTitle && line.variantTitle !== 'Default Title' && (
                      <span className="text-secondary">{line.variantTitle}</span>
                    )}
                    <span className="num text-secondary">
                      {money(line.unitPrice)} × {formatCount(line.quantity)}
                    </span>
                  </span>
                  <span className="num">{money(line.totalPrice)}</span>
                </li>
              ))}
            </ul>
            <dl className="flex flex-col gap-1 border-t border-line pt-3">
              <Row label={t('order.subtotal')} value={money(order.subtotalPrice)} />
              <Row label={t('order.shipping')} value={money(order.totalShippingPrice)} />
              {discounted && (
                <Row label={t('order.discount')} value={`-${money(order.totalDiscounts)}`} />
              )}
              {fee && <Row label={t('order.codFee')} value={money(order.codFee)} />}
              <Row label={t('order.total')} value={money(order.totalPrice)} strong />
              {Number(order.amountPaid.amount) > 0 && (
                <Row label={t('order.paid')} value={money(order.amountPaid)} />
              )}
              {toCollect && (
                <Row label={t('order.toCollect')} value={money(order.codAmount)} strong />
              )}
            </dl>
          </Section>
          <Section title={t('order.timeline')}>
            <ol className="flex flex-col gap-3">
              {order.events.nodes.map((event) => (
                <li key={event.id} className="flex flex-col">
                  <span>{event.message}</span>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {event.author?.name ? `${event.author.name} · ` : ''}
                    {formatRelative(event.createdAt, timezone, locale)}
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        </div>
        <div className="flex flex-col gap-4">
          <Section title={t('order.customer')}>
            {order.overPlanLimit ? (
              <p className="flex items-center gap-2 text-secondary">
                <EyeOff aria-hidden className="size-5" />
                {t('orders.hidden')}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                <span className="font-medium">
                  {order.customer?.displayName ?? order.shippingAddress.name}
                </span>
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
            <address className="not-italic">
              {order.shippingAddress.formatted.map((line, index) => (
                <div key={index}>{line}</div>
              ))}
            </address>
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
                {t('order.riskScore', { score: Math.round(order.risk.score) })}
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
