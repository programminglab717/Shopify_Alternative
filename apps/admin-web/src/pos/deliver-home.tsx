import { useState } from 'react';
import type { FormEvent } from 'react';
import { PosOrderCreateMutation } from '../api/operations';
import type { PosDeliveryPayment, PosOrderCreateData, PosTenderMethod } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { amountOf, type CartLine } from './cart';
import { METHOD_LABELS, METHODS } from './till';

/**
 * The cart sent to the customer's home as an order (POS-08, the endless aisle, ADR-873): their
 * name, number and address, confirmed by them at the counter, shipped from wherever the shop
 * ships from; paid now in full, an advance now, or all on delivery. Needs a connection.
 */
export function DeliverHome({
  sessionId,
  lines,
  discount,
  onPlaced,
  onBack,
}: {
  sessionId: string;
  lines: readonly CartLine[];
  /** In paisa. */
  discount: number;
  onPlaced: (order: { name: string; total: string; paid: string }) => void;
  onBack: () => void;
}) {
  const { t } = useLocale();
  const place = useAdminMutation<PosOrderCreateData, { input: Record<string, unknown> }>(
    PosOrderCreateMutation,
  );
  const [address, setAddress] = useState({ name: '', phone: '', address1: '', city: '' });
  const [payment, setPayment] = useState<PosDeliveryPayment>('PAID');
  const [advance, setAdvance] = useState('');
  const [method, setMethod] = useState<PosTenderMethod>('CASH');
  const [delivery, setDelivery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const field = (key: keyof typeof address) => ({
    value: address[key],
    onChange: (event: { target: { value: string } }) =>
      setAddress({ ...address, [key]: event.target.value }),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { posOrderCreate } = await place.mutateAsync({
        input: {
          sessionId,
          lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
          ...(discount > 0 && { discount: amountOf(discount) }),
          ...(delivery.trim() && { shippingPrice: delivery.trim() }),
          address,
          payment,
          ...(payment === 'ADVANCE' && { advance }),
          ...(payment !== 'ON_DELIVERY' && { method }),
        },
      });
      const error = posOrderCreate.userErrors[0];
      if (error || !posOrderCreate.order) {
        setProblem(error ? problemText(error, t) : t('pos.notSold'));
        return;
      }
      const order = posOrderCreate.order;
      onPlaced({ name: order.name, total: order.total.amount, paid: order.paid.amount });
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <h3 className="font-semibold">{t('pos.deliverTitle')}</h3>
      <TextField label={t('pos.deliverName')} autoComplete="off" {...field('name')} />
      <TextField label={t('pos.deliverPhone')} inputMode="tel" ltr {...field('phone')} />
      <TextField label={t('pos.deliverAddress')} {...field('address1')} />
      <TextField label={t('pos.deliverCity')} {...field('city')} />
      <TextField
        label={t('pos.deliveryCharge')}
        inputMode="decimal"
        ltr
        value={delivery}
        onChange={(event) => setDelivery(event.target.value)}
      />
      <SelectField
        label={t('pos.deliverPayment')}
        value={payment}
        options={(['PAID', 'ADVANCE', 'ON_DELIVERY'] as const).map((each) => ({
          value: each,
          label: t(`pos.deliverPayment.${each}`),
        }))}
        onChange={setPayment}
      />
      {payment === 'ADVANCE' && (
        <TextField
          label={t('pos.advance')}
          inputMode="decimal"
          ltr
          value={advance}
          onChange={(event) => setAdvance(event.target.value)}
        />
      )}
      {payment !== 'ON_DELIVERY' && (
        <SelectField
          label={t('pos.paidBy')}
          value={method}
          options={METHODS.map((each) => ({ value: each, label: t(METHOD_LABELS[each]) }))}
          onChange={setMethod}
        />
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={place.isPending}>
          {t('pos.deliverPlace')}
        </Button>
        <Button variant="tertiary" onClick={onBack}>
          {t('action.back')}
        </Button>
      </div>
    </form>
  );
}

/** What the till says once the order is placed. */
export function placedText(
  t: ReturnType<typeof useLocale>['t'],
  order: { name: string; paid: string },
): string {
  return Number(order.paid) > 0
    ? t('pos.deliverPlacedPaid', { name: order.name, amount: formatMoney(order.paid) })
    : t('pos.deliverPlaced', { name: order.name });
}
