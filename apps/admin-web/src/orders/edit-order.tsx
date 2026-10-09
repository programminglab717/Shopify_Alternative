import { Minus, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { OrderEditChargesMutation, OrderEditLineItemsMutation } from '../api/operations';
import type { MoneyValue, OrderDetail, OrderEditData, OrderStage } from '../api/types';
import { ProductPicker } from '../drafts/new-draft-page';
import type { PickedVariant } from '../drafts/new-draft-page';
import { formatCount, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { parsePrice, priceText } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { WORKS_PARCELS } from './parcels';

/** The stages an order waits to be packed in, when its items and charges may change. */
const WAITING: readonly OrderStage[] = [
  'NEEDS_CONFIRMATION',
  'NEEDS_REVIEW',
  'AWAITING_PAYMENT',
  'TO_PACK',
];

const cents = (amount: string) => Math.round(Number(amount) * 100);
const rupees = (value: number) => (value / 100).toFixed(2);

/**
 * Whether an order's items and charges can change, as the core allows (ADR-131, ADR-134): open,
 * waiting to be packed, nothing shipped and nothing refunded, and within the shop's plan.
 */
export function changeable(
  order: Pick<OrderDetail, 'status' | 'stage' | 'fulfillments' | 'refunds' | 'overPlanLimit'>,
): boolean {
  return (
    order.status === 'OPEN' &&
    !order.overPlanLimit &&
    WAITING.includes(order.stage) &&
    order.fulfillments.length === 0 &&
    order.refunds.length === 0
  );
}

function money(value: MoneyValue): string {
  return formatMoney(value.amount, value.currencyCode);
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'font-semibold' : ''}`}>
      <dt className={strong ? '' : 'text-secondary'}>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

function Stepper({
  title,
  quantity,
  least,
  onChange,
}: {
  title: string;
  quantity: number;
  least: number;
  onChange: (quantity: number) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="secondary"
        aria-label={t('drafts.fewer', { title })}
        disabled={quantity <= least}
        icon={<Minus aria-hidden className="size-5" />}
        onClick={() => onChange(quantity - 1)}
      />
      <span className="num min-w-10 text-center" aria-live="polite">
        {formatCount(quantity)}
      </span>
      <Button
        variant="secondary"
        aria-label={t('drafts.more', { title })}
        icon={<Plus aria-hidden className="size-5" />}
        onClick={() => onChange(quantity + 1)}
      />
    </div>
  );
}

/** What an edit left the order at, said back as the agent reads it to the customer. */
function useSaid() {
  const { t } = useLocale();
  return (result: OrderEditData[string]['order']) => {
    if (!result) return t('orderEdit.saved.plain');
    const total = money(result.totalPrice);
    const said =
      cents(result.codAmount.amount) > 0
        ? t('orderEdit.saved.collect', { total, cash: money(result.codAmount) })
        : t('orderEdit.saved', { total });
    return result.stage === 'NEEDS_REVIEW' ? `${said} ${t('orderEdit.review')}` : said;
  };
}

const lineTitle = (line: OrderDetail['lineItems'][number]) =>
  line.variantTitle && line.variantTitle !== 'Default Title'
    ? `${line.title} · ${line.variantTitle}`
    : line.title;

interface Added extends PickedVariant {
  quantity: number;
}

/**
 * The order's items changed on the call (ADR-131): its lines' quantities, 0 taking one off, and
 * variants found and added, at their price now or one agreed. The lines kept keep their prices.
 */
function ItemsForm({ order, onDone }: { order: OrderDetail; onDone: (said: string) => void }) {
  const { t } = useLocale();
  const edit = useAdminMutation<OrderEditData, { id: string; input: Record<string, unknown> }>(
    OrderEditLineItemsMutation,
  );
  const { problem, attempt } = useAttempt();
  const said = useSaid();
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(order.lineItems.map((line) => [line.id, line.quantity])),
  );
  const [added, setAdded] = useState<Added[]>([]);
  const [local, setLocal] = useState<string | null>(null);

  const onAdd = (picked: PickedVariant) => {
    // A variant on the order already changes by its line, as the core does.
    const line = order.lineItems.find((each) => each.variantId === picked.variantId);
    if (line) {
      setQuantities((now) => ({ ...now, [line.id]: (now[line.id] ?? 0) + 1 }));
      return;
    }
    setAdded((now) =>
      now.some((each) => each.variantId === picked.variantId)
        ? now.map((each) =>
            each.variantId === picked.variantId ? { ...each, quantity: each.quantity + 1 } : each,
          )
        : [...now, { ...picked, quantity: 1 }],
    );
  };
  const change = (variantId: string, next: Partial<Added> | null) =>
    setAdded((now) =>
      next === null
        ? now.filter((each) => each.variantId !== variantId)
        : now.map((each) => (each.variantId === variantId ? { ...each, ...next } : each)),
    );

  const agreed = (line: Added) => parsePrice(line.agreed) ?? line.price.amount;
  const was = cents(order.subtotalPrice.amount);
  const now =
    order.lineItems.reduce(
      (sum, line) => sum + cents(line.unitPrice.amount) * (quantities[line.id] ?? 0),
      0,
    ) + added.reduce((sum, line) => sum + cents(agreed(line)) * line.quantity, 0);
  const setQuantitiesInput = order.lineItems
    .filter((line) => quantities[line.id] !== line.quantity)
    .map((line) => ({ lineItemId: line.id, quantity: quantities[line.id] ?? 0 }));
  const unchanged = setQuantitiesInput.length === 0 && added.length === 0;
  const empty =
    order.lineItems.every((line) => (quantities[line.id] ?? 0) === 0) && added.length === 0;
  const badPrice = added.find((line) => line.agreed.trim() && !parsePrice(line.agreed));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLocal(null);
    if (empty) return setLocal(t('orderEdit.empty'));
    if (badPrice) return setLocal(t('orderEdit.badPrice', { title: badPrice.title }));
    let result: OrderEditData[string]['order'] = null;
    const ok = await attempt(async () => {
      const payload = Object.values(
        await edit.mutateAsync({
          id: order.id,
          input: {
            ...(setQuantitiesInput.length > 0 && { setQuantities: setQuantitiesInput }),
            ...(added.length > 0 && {
              addVariants: added.map((line) => {
                const price = parsePrice(line.agreed);
                return {
                  variantId: line.variantId,
                  quantity: line.quantity,
                  ...(price && price !== priceText(line.price.amount) && { price }),
                };
              }),
            }),
          },
        }),
      )[0]!;
      result = payload.order;
      return payload;
    });
    if (ok) onDone(said(result));
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <p className="text-secondary">{t('orderEdit.keepsPrices')}</p>
      <ul className="flex flex-col divide-y divide-line">
        {order.lineItems.map((line) => {
          const title = lineTitle(line);
          const quantity = quantities[line.id] ?? 0;
          const off = quantity === 0;
          return (
            <li key={line.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 flex-col">
                <span dir="auto" className={`font-medium ${off ? 'line-through' : ''}`}>
                  {title}
                </span>
                <span className="num text-secondary">
                  {off ? t('orderEdit.off') : money(line.unitPrice)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {!off && (
                  <Stepper
                    title={title}
                    quantity={quantity}
                    least={1}
                    onChange={(next) => setQuantities((all) => ({ ...all, [line.id]: next }))}
                  />
                )}
                <Button
                  variant={off ? 'secondary' : 'danger'}
                  aria-label={t(off ? 'orderEdit.putBack' : 'orderEdit.takeOff', { title })}
                  icon={
                    off ? (
                      <Undo2 aria-hidden className="size-5" />
                    ) : (
                      <Trash2 aria-hidden className="size-5" />
                    )
                  }
                  onClick={() =>
                    setQuantities((all) => ({ ...all, [line.id]: off ? line.quantity || 1 : 0 }))
                  }
                />
              </span>
            </li>
          );
        })}
        {added.map((line) => (
          <li key={line.variantId} className="flex flex-col gap-2 py-2">
            <span className="flex items-start justify-between gap-2">
              <span className="flex min-w-0 flex-col">
                <span dir="auto" className="font-medium">
                  {line.title}
                </span>
                <span className="text-primary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('orderEdit.added')}
                </span>
              </span>
              <Button
                variant="danger"
                aria-label={t('drafts.remove', { title: line.title })}
                icon={<Trash2 aria-hidden className="size-5" />}
                onClick={() => change(line.variantId, null)}
              />
            </span>
            <span className="flex flex-wrap items-end gap-3">
              <Stepper
                title={line.title}
                quantity={line.quantity}
                least={1}
                onChange={(quantity) => change(line.variantId, { quantity })}
              />
              <TextField
                label={t('drafts.price', { title: line.title })}
                inputMode="decimal"
                ltr
                className="w-36"
                value={line.agreed}
                onChange={(event) => change(line.variantId, { agreed: event.target.value })}
              />
            </span>
          </li>
        ))}
      </ul>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">{t('orderEdit.addTitle')}</legend>
        <ProductPicker onAdd={onAdd} />
      </fieldset>
      {!unchanged && (
        <p className="num font-medium" aria-live="polite">
          {t('orderEdit.itemsNow', {
            now: formatMoney(rupees(now), order.subtotalPrice.currencyCode),
            was: formatMoney(rupees(was), order.subtotalPrice.currencyCode),
          })}
        </p>
      )}
      {(local ?? problem) && <Alert tone="danger">{local ?? problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={edit.isPending} disabled={unchanged}>
          {t('orderEdit.saveItems')}
        </Button>
        <Button variant="tertiary" onClick={() => onDone('')}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The order's delivery charge and discount changed on the call (ADR-134): the one waived, the
 * other given; what was taken off for paying by transfer stays part of the discount.
 */
function ChargesForm({ order, onDone }: { order: OrderDetail; onDone: (said: string) => void }) {
  const { t } = useLocale();
  const edit = useAdminMutation<OrderEditData, { id: string; input: Record<string, unknown> }>(
    OrderEditChargesMutation,
  );
  const { problem, attempt } = useAttempt();
  const said = useSaid();
  const [delivery, setDelivery] = useState(priceText(order.totalShippingPrice.amount) || '0');
  const [discount, setDiscount] = useState(priceText(order.totalDiscounts.amount) || '0');
  const least = cents(order.transferDiscount.amount);
  const shippingPrice = parsePrice(delivery);
  const discountAmount = parsePrice(discount);
  const deliveryError = shippingPrice === null ? t('orderEdit.badAmount') : null;
  const discountError =
    discountAmount === null
      ? t('orderEdit.badAmount')
      : cents(discountAmount) < least
        ? t('orderEdit.discountAtLeast', { amount: money(order.transferDiscount) })
        : null;
  const input = {
    ...(shippingPrice !== null &&
      cents(shippingPrice) !== cents(order.totalShippingPrice.amount) && { shippingPrice }),
    ...(discountAmount !== null &&
      cents(discountAmount) !== cents(order.totalDiscounts.amount) && {
        discount: discountAmount,
      }),
  };
  const unchanged = Object.keys(input).length === 0;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (deliveryError || discountError) return;
    let result: OrderEditData[string]['order'] = null;
    const ok = await attempt(async () => {
      const payload = Object.values(await edit.mutateAsync({ id: order.id, input }))[0]!;
      result = payload.order;
      return payload;
    });
    if (ok) onDone(said(result));
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label={t('orderEdit.delivery')}
          inputMode="decimal"
          ltr
          className="w-40"
          value={delivery}
          error={deliveryError}
          onChange={(event) => setDelivery(event.target.value)}
        />
        {cents(order.totalShippingPrice.amount) > 0 && (
          <Button variant="secondary" onClick={() => setDelivery('0')}>
            {t('orderEdit.waive')}
          </Button>
        )}
      </div>
      <TextField
        label={t('orderEdit.discount')}
        hint={
          least > 0
            ? t('orderEdit.discountAtLeast', { amount: money(order.transferDiscount) })
            : t('orderEdit.discountHint')
        }
        inputMode="decimal"
        ltr
        className="w-40"
        value={discount}
        error={discountError}
        onChange={(event) => setDiscount(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          busy={edit.isPending}
          disabled={unchanged || !!deliveryError || !!discountError}
        >
          {t('orderEdit.saveCharges')}
        </Button>
        <Button variant="tertiary" onClick={() => onDone('')}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * An order's items and totals (ORD-02), changed while it waits to be packed (ORD-04) by those who
 * work orders: what it holds, on the call, and what it charges for delivery and takes off. A
 * packed order is unpacked first.
 */
export function OrderItems({ order }: { order: OrderDetail }) {
  const { t } = useLocale();
  const { role } = useShop();
  const [open, setOpen] = useState<'items' | 'charges' | null>(null);
  const [done, setDone] = useState('');
  const works = WORKS_PARCELS.includes(role);
  const editable = works && changeable(order);
  const packed =
    works &&
    order.status === 'OPEN' &&
    order.stage === 'TO_BOOK' &&
    order.fulfillments.length === 0;
  const finish = (said: string) => {
    setOpen(null);
    setDone(said);
  };

  if (open === 'items') return <ItemsForm order={order} onDone={finish} />;
  if (open === 'charges') return <ChargesForm order={order} onDone={finish} />;

  return (
    <>
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
        {cents(order.totalDiscounts.amount) > 0 && (
          <Row label={t('order.discount')} value={`-${money(order.totalDiscounts)}`} />
        )}
        {cents(order.codFee.amount) > 0 && (
          <Row label={t('order.codFee')} value={money(order.codFee)} />
        )}
        <Row label={t('order.total')} value={money(order.totalPrice)} strong />
        {cents(order.amountPaid.amount) > 0 && (
          <Row label={t('order.paid')} value={money(order.amountPaid)} />
        )}
        {cents(order.codAmount.amount) > 0 && (
          <Row label={t('order.toCollect')} value={money(order.codAmount)} strong />
        )}
      </dl>
      {done && <Alert tone="success">{done}</Alert>}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Pencil aria-hidden className="size-5" />}
            onClick={() => {
              setDone('');
              setOpen('items');
            }}
          >
            {t('orderEdit.items')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDone('');
              setOpen('charges');
            }}
          >
            {t('orderEdit.charges')}
          </Button>
        </div>
      )}
      {packed && <p className="text-secondary">{t('orderEdit.packed')}</p>}
    </>
  );
}
