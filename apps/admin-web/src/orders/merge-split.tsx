import { useNavigate } from '@tanstack/react-router';
import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  OrderMergeCandidatesQuery,
  OrderMergeMutation,
  OrderSplitMutation,
} from '../api/operations';
import type {
  OrderDetail,
  OrderMergeCandidatesData,
  OrderMergeSplitData,
  OrderStage,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { parsePrice } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** The stages an order waits to be packed in, when it may be merged or split. */
const WAITING: readonly OrderStage[] = [
  'NEEDS_CONFIRMATION',
  'NEEDS_REVIEW',
  'AWAITING_PAYMENT',
  'TO_PACK',
];

/** What came of a merge or a split: what to say, and the order to open. */
export interface Made {
  said: string;
  order?: { id: string; name: string };
}

const units = (order: Pick<OrderDetail, 'lineItems'>) =>
  order.lineItems.reduce((sum, line) => sum + line.quantity, 0);

/** Whether an order can be sent apart in part (ADR-135): paid on delivery, nothing paid yet. */
export function splittable(
  order: Pick<OrderDetail, 'paymentMethod' | 'amountPaid' | 'lineItems'>,
): boolean {
  return (
    order.paymentMethod === 'CASH_ON_DELIVERY' &&
    Number(order.amountPaid.amount) === 0 &&
    units(order) > 1
  );
}

/** Whether an order can be merged into another of its customer's (ADR-132). */
export function mergeable(order: Pick<OrderDetail, 'customer' | 'amountPaid'>): boolean {
  return order.customer !== null && Number(order.amountPaid.amount) === 0;
}

/**
 * The order merged into another of its customer's (ADR-132), as when they placed it twice: the
 * other, waiting to be packed and paid the same way, takes its items and discount and keeps its
 * own address and delivery charge; this one is cancelled as merged. The other's page opens.
 */
export function MergeForm({ order, onDone }: { order: OrderDetail; onDone: () => void }) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const navigate = useNavigate();
  const query = useAdminQuery<OrderMergeCandidatesData>(
    ['orderMergeCandidates', order.id],
    OrderMergeCandidatesQuery,
    { id: order.id },
  );
  const merge = useAdminMutation<OrderMergeSplitData, { id: string; intoId: string }>(
    OrderMergeMutation,
  );
  const { problem, attempt } = useAttempt();
  const [into, setInto] = useState<string | null>(null);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const candidates = (query.data.order?.customer?.orders.nodes ?? []).filter(
    (other) =>
      other.id !== order.id &&
      other.status === 'OPEN' &&
      WAITING.includes(other.stage) &&
      other.paymentMethod === order.paymentMethod,
  );
  const chosen = candidates.find((other) => other.id === into);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    const result: { order?: { id: string; name: string } | null } = {};
    const ok = await attempt(async () => {
      const payload = Object.values(
        await merge.mutateAsync({ id: order.id, intoId: chosen.id }),
      )[0]!;
      result.order = payload.order;
      return payload;
    });
    if (!ok) return;
    const target = result.order ?? chosen;
    await navigate({
      to: '/$shopId/orders/$orderId',
      params: { shopId: shop.id, orderId: target.id },
    });
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <h3 className="font-semibold">{t('orderMerge.title', { name: order.name })}</h3>
      {candidates.length === 0 ? (
        <p className="text-secondary">{t('orderMerge.none')}</p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium">{t('orderMerge.into')}</legend>
          {candidates.map((other) => (
            <label key={other.id} className="flex min-h-12 items-start gap-2 py-1">
              <input
                type="radio"
                name="into"
                value={other.id}
                checked={into === other.id}
                onChange={() => setInto(other.id)}
                className="mt-1 size-5 accent-[var(--hatti-color-primary)]"
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">
                  <span className="num">{other.name}</span> ·{' '}
                  {formatDate(other.createdAt, timezone, locale)} ·{' '}
                  <span className="num">
                    {formatMoney(other.totalPrice.amount, other.totalPrice.currencyCode)}
                  </span>
                </span>
                <span className="text-secondary" dir="auto">
                  {other.lineItems
                    .map((line) => `${formatCount(line.quantity)} × ${line.title}`)
                    .join(', ')}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {chosen && (
        <p className="text-secondary">
          {t('orderMerge.explain', { name: order.name, into: chosen.name })}
        </p>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        {candidates.length > 0 && (
          <Button type="submit" busy={merge.isPending} disabled={!chosen}>
            {chosen ? t('orderMerge.submit', { into: chosen.name }) : t('orderMerge.choose')}
          </Button>
        )}
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Items sent apart as an order of their own (ADR-135), as when part waits for stock or the
 * customer wants part sooner: units of each line, and the delivery charge of the order sent
 * apart, nothing if left empty. Something stays on this order.
 */
export function SplitForm({
  order,
  onDone,
}: {
  order: OrderDetail;
  onDone: (made: Made | null) => void;
}) {
  const { t } = useLocale();
  const split = useAdminMutation<
    OrderMergeSplitData,
    { id: string; input: Record<string, unknown> }
  >(OrderSplitMutation);
  const { problem, attempt } = useAttempt();
  const [apart, setApart] = useState<Record<string, number>>({});
  const [delivery, setDelivery] = useState('');
  const chosen = order.lineItems
    .map((line) => ({ lineItemId: line.id, quantity: apart[line.id] ?? 0 }))
    .filter((line) => line.quantity > 0);
  const sent = chosen.reduce((sum, line) => sum + line.quantity, 0);
  const all = sent === units(order);
  const shippingPrice = delivery.trim() ? parsePrice(delivery) : undefined;
  const deliveryError = shippingPrice === null ? t('orderEdit.badAmount') : null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (sent === 0 || all || deliveryError) return;
    const result: { order?: { id: string; name: string } | null } = {};
    const ok = await attempt(async () => {
      const payload = Object.values(
        await split.mutateAsync({
          id: order.id,
          input: { lineItems: chosen, ...(shippingPrice && { shippingPrice }) },
        }),
      )[0]!;
      result.order = payload.splitOrder;
      return payload;
    });
    if (!ok) return;
    const made = result.order;
    onDone(
      made
        ? { said: t('orderSplit.done', { name: made.name }), order: made }
        : { said: t('orderEdit.saved.plain') },
    );
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <h3 className="font-semibold">{t('orderSplit.title')}</h3>
      <p className="text-secondary">{t('orderSplit.explain')}</p>
      <ul className="flex flex-col divide-y divide-line">
        {order.lineItems.map((line) => {
          const title =
            line.variantTitle && line.variantTitle !== 'Default Title'
              ? `${line.title} · ${line.variantTitle}`
              : line.title;
          const count = apart[line.id] ?? 0;
          const set = (next: number) => setApart((now) => ({ ...now, [line.id]: next }));
          return (
            <li key={line.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 flex-col">
                <span dir="auto" className="font-medium">
                  {title}
                </span>
                <span className="text-secondary">
                  {t('orderSplit.of', { count: formatCount(line.quantity) })}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <Button
                  variant="secondary"
                  aria-label={t('orderSplit.fewer', { title })}
                  disabled={count <= 0}
                  icon={<Minus aria-hidden className="size-5" />}
                  onClick={() => set(count - 1)}
                />
                <span className="num min-w-10 text-center" aria-live="polite">
                  {formatCount(count)}
                </span>
                <Button
                  variant="secondary"
                  aria-label={t('orderSplit.more', { title })}
                  disabled={count >= line.quantity}
                  icon={<Plus aria-hidden className="size-5" />}
                  onClick={() => set(count + 1)}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <TextField
        label={t('orderSplit.delivery')}
        hint={t('orderSplit.deliveryHint')}
        inputMode="decimal"
        ltr
        className="w-40"
        value={delivery}
        error={deliveryError}
        onChange={(event) => setDelivery(event.target.value)}
      />
      {all && <Alert tone="warning">{t('orderSplit.all')}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          busy={split.isPending}
          disabled={sent === 0 || all || !!deliveryError}
        >
          {t('orderSplit.submit', { count: formatCount(sent) })}
        </Button>
        <Button variant="tertiary" onClick={() => onDone(null)}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}
