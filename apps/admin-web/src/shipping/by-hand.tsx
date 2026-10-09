/** Packed orders shipped by hand, many at once (SHP-04): a courier Hatti does not book with. */
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { OrderFulfillMutation } from '../api/operations';
import type { OrderListItem, ParcelUserErrorsData } from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { COURIERS, trackingProblem } from '../orders/parcels';
import { useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card } from '../ui/feedback';
import { TextField } from '../ui/field';

/** What became of the orders shipped by hand: how many went, and each refused, said why. */
export interface ShippedByHand {
  shipped: number;
  refused: string[];
}

/**
 * Packed orders shipped by hand at once, with a courier Hatti does not book with yet or the
 * shop's own rider: the courier named once, each order's tracking number beside it, any left
 * empty. Each ships everything it has left in one parcel, one after another; those the core
 * refuses stay packed, said by name.
 */
export function ShipByHand({
  orders,
  onDone,
  onCancel,
}: {
  orders: readonly OrderListItem[];
  onDone: (outcome: ShippedByHand) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const store = useSessionStore();
  const shopId = useShop().id;
  const queryClient = useQueryClient();
  const couriers = useId();
  const [company, setCompany] = useState('');
  const [numbers, setNumbers] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const outcome: ShippedByHand = { shipped: 0, refused: [] };
    for (const order of orders) {
      try {
        const { orderFulfill } = await store.graphql<ParcelUserErrorsData>(
          shopId,
          OrderFulfillMutation,
          {
            id: order.id,
            trackingInfo: {
              company: company.trim() || null,
              number: numbers[order.id]?.trim() || null,
              url: null,
            },
          },
          { idempotencyKey: crypto.randomUUID() },
        );
        if (orderFulfill!.userErrors.length === 0) outcome.shipped += 1;
        else {
          const why = orderFulfill!.userErrors.map((error) => trackingProblem(error, t));
          outcome.refused.push(`${order.name}: ${why.join(' ')}`);
        }
      } catch (failure) {
        outcome.refused.push(`${order.name}: ${errorText(failure, t)}`);
      }
    }
    // The orders, their stages and the home's counts, asked again once all have gone.
    await queryClient.invalidateQueries({ queryKey: ['admin', shopId] });
    setBusy(false);
    onDone(outcome);
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="font-semibold">
        {t('shipping.byHand.title', { count: formatCount(orders.length) })}
      </h2>
      <p className="text-secondary">{t('shipping.byHand.hint')}</p>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <TextField
          label={t('parcels.tracking.company')}
          hint={t('parcels.tracking.companyHint')}
          dir="auto"
          maxLength={100}
          list={couriers}
          value={company}
          onChange={(event) => setCompany(event.target.value)}
        />
        <datalist id={couriers}>
          {COURIERS.map((each) => (
            <option key={each} value={each} />
          ))}
        </datalist>
        <ul className="flex flex-col divide-y divide-line">
          {orders.map((order) => (
            <li key={order.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-end">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="num font-semibold">{order.name}</span>
                <span className="truncate text-secondary">
                  {order.customer?.displayName ?? order.shippingAddress.name}
                  {order.shippingAddress.city ? ` · ${order.shippingAddress.city}` : ''}
                </span>
              </span>
              <TextField
                label={t('shipping.byHand.number', { name: order.name })}
                ltr
                autoCapitalize="characters"
                maxLength={100}
                className="sm:w-64"
                value={numbers[order.id] ?? ''}
                onChange={(event) =>
                  setNumbers((current) => ({ ...current, [order.id]: event.target.value }))
                }
              />
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy}>
            {t('shipping.byHand.save', { count: formatCount(orders.length) })}
          </Button>
          <Button variant="tertiary" disabled={busy} onClick={onCancel}>
            {t('returns.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
