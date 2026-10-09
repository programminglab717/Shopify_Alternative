import { Link } from '@tanstack/react-router';
import type { OrderStage as BadgeColour } from '@hatti/tokens';
import type { LucideIcon } from 'lucide-react';
import { CircleCheck, CircleMinus, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ProductVariantsQuery,
  ReturnCancelMutation,
  ReturnCreateMutation,
  ReturnReceiveMutation,
} from '../api/operations';
import type {
  OrderDetail,
  ParcelUserErrorsData,
  ProductVariantsData,
  ReturnCreateData,
  ReturnDetail,
  ReturnReason,
} from '../api/types';
import { formatCount, formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { parsePrice } from '../products/product-form';
import { trackingText, useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { WORKS_PARCELS } from './parcels';
import { RestockForm } from './restock-form';
import type { Restock } from './restock-form';

export const REASONS: readonly ReturnReason[] = [
  'SIZE_TOO_SMALL',
  'SIZE_TOO_LARGE',
  'DEFECTIVE',
  'NOT_AS_DESCRIBED',
  'WRONG_ITEM',
  'UNWANTED',
  'OTHER',
];

const STATUS_BADGES: Record<
  ReturnDetail['status'],
  { colour: BadgeColour; icon: LucideIcon; label: MessageKey }
> = {
  OPEN: { colour: 'returned', icon: Undo2, label: 'orderReturns.status.OPEN' },
  CLOSED: { colour: 'delivered', icon: CircleCheck, label: 'orderReturns.status.CLOSED' },
  CANCELLED: { colour: 'cancelled', icon: CircleMinus, label: 'orderReturns.status.CANCELLED' },
};

/**
 * How many of each line can still come back: delivered in its parcels, less what returns not
 * cancelled bring back already.
 */
export function returnable(order: Pick<OrderDetail, 'fulfillments' | 'returns'>) {
  const left = new Map<string, number>();
  for (const parcel of order.fulfillments) {
    if (parcel.status !== 'DELIVERED') continue;
    for (const each of parcel.fulfillmentLineItems) {
      left.set(each.lineItem.id, (left.get(each.lineItem.id) ?? 0) + each.quantity);
    }
  }
  for (const back of order.returns) {
    if (back.status === 'CANCELLED') continue;
    for (const each of back.returnLineItems) {
      const id = each.lineItem.id;
      if (left.has(id)) left.set(id, Math.max(0, left.get(id)! - each.quantity));
    }
  }
  return left;
}

/** Another variant of the product to send in exchange; the one coming back left out. */
function VariantChoice({
  productId,
  exclude,
  value,
  onChange,
}: {
  productId: string;
  exclude: string;
  value: string;
  onChange: (variantId: string) => void;
}) {
  const { t } = useLocale();
  const query = useAdminQuery<ProductVariantsData>(
    ['productVariants', productId],
    ProductVariantsQuery,
    {
      id: productId,
    },
  );
  const variants = (query.data?.product?.variants ?? []).filter((each) => each.id !== exclude);
  return (
    <SelectField<string>
      label={t('orderReturns.exchangeFor')}
      value={value}
      options={[
        { value: '', label: t('orderReturns.noExchange') },
        ...variants.map((each) => ({
          value: each.id,
          label: each.availableForSale
            ? t('orderReturns.variant', {
                title: each.title,
                count: formatCount(each.inventoryQuantity),
              })
            : t('orderReturns.variantOut', { title: each.title }),
        })),
      ]}
      onChange={onChange}
    />
  );
}

interface Choice {
  quantity: string;
  reason: ReturnReason;
  exchange: string;
}

/**
 * A return recorded (ADR-136, ADR-137): how many of each delivered line come back and why,
 * another variant sent at once in exchange if asked, and how the parcel comes back.
 */
function RecordReturn({
  order,
  left,
  onDone,
}: {
  order: OrderDetail;
  left: Map<string, number>;
  onDone: (message: string) => void;
}) {
  const { t } = useLocale();
  const lines = order.lineItems.filter((line) => (left.get(line.id) ?? 0) > 0);
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      lines.map((line) => [line.id, { quantity: '0', reason: 'SIZE_TOO_SMALL', exchange: '' }]),
    ),
  );
  const [company, setCompany] = useState('');
  const [number, setNumber] = useState('');
  const [note, setNote] = useState('');
  const [charge, setCharge] = useState('');
  const create = useAdminMutation<ReturnCreateData, Record<string, unknown>>(ReturnCreateMutation);
  const { problem, attempt } = useAttempt();

  const set = (id: string, change: Partial<Choice>) =>
    setChoices({ ...choices, [id]: { ...choices[id]!, ...change } });
  const chosen = lines
    .map((line) => ({ line, choice: choices[line.id]!, most: left.get(line.id)! }))
    .map((each) => ({
      ...each,
      quantity: /^\d+$/.test(each.choice.quantity) ? Number(each.choice.quantity) : Number.NaN,
    }));
  const wrong = chosen.some((each) => !(each.quantity >= 0 && each.quantity <= each.most));
  const coming = chosen.filter((each) => each.quantity > 0);
  const exchanging = coming.filter((each) => each.choice.exchange);
  const chargeOk = !charge.trim() || parsePrice(charge) !== null;
  const ready = !wrong && coming.length > 0 && chargeOk;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    let made: ReturnCreateData['returnCreate']['return'] = null;
    const done = await attempt(async () => {
      const result = (
        await create.mutateAsync({
          input: {
            orderId: order.id,
            returnLineItems: coming.map((each) => ({
              lineItemId: each.line.id,
              quantity: each.quantity,
              returnReason: each.choice.reason,
            })),
            ...(exchanging.length > 0
              ? {
                  exchangeLineItems: exchanging.map((each) => ({
                    variantId: each.choice.exchange,
                    quantity: each.quantity,
                  })),
                  ...(charge.trim() ? { exchangeShippingPrice: parsePrice(charge) } : {}),
                }
              : {}),
            ...(company.trim() || number.trim()
              ? {
                  trackingInfo: {
                    company: company.trim() || null,
                    number: number.trim() || null,
                  },
                }
              : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        })
      ).returnCreate;
      made = result.return;
      return result;
    });
    if (done && made) {
      const back = made as NonNullable<ReturnCreateData['returnCreate']['return']>;
      onDone(
        back.exchangeOrder
          ? t('orderReturns.recordedWithExchange', {
              name: back.name,
              exchange: back.exchangeOrder.name,
            })
          : t('orderReturns.recorded', { name: back.name }),
      );
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-line">
        {chosen.map(({ line, choice, most }) => (
          <li key={line.id} className="flex flex-col gap-3 py-3 first:pt-0">
            <span className="flex flex-col">
              <span className="font-medium" dir="auto">
                {line.title}
              </span>
              {line.variantTitle !== 'Default Title' && (
                <span className="text-secondary" dir="auto">
                  {line.variantTitle}
                </span>
              )}
            </span>
            <div className="grid gap-3 md:grid-cols-2">
              <TextField
                label={t('orderReturns.howMany', { count: formatCount(most) })}
                inputMode="numeric"
                ltr
                value={choice.quantity}
                onChange={(event) => set(line.id, { quantity: event.target.value.trim() })}
              />
              <SelectField<ReturnReason>
                label={t('orderReturns.why')}
                value={choice.reason}
                options={REASONS.map((each) => ({
                  value: each,
                  label: t(`orderReturns.reason.${each}` as MessageKey),
                }))}
                onChange={(reason) => set(line.id, { reason })}
              />
            </div>
            {choice.quantity !== '0' && choice.quantity !== '' && (
              <VariantChoice
                productId={line.productId}
                exclude={line.variantId}
                value={choice.exchange}
                onChange={(exchange) => set(line.id, { exchange })}
              />
            )}
          </li>
        ))}
      </ul>
      {exchanging.length > 0 && (
        <TextField
          label={t('orderReturns.exchangeCharge')}
          hint={t('orderReturns.exchangeChargeHint')}
          inputMode="decimal"
          ltr
          value={charge}
          error={chargeOk ? null : t('returns.claim.amountWrong')}
          onChange={(event) => setCharge(event.target.value)}
        />
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <TextField
          label={t('orderReturns.courier')}
          value={company}
          onChange={(event) => setCompany(event.target.value)}
        />
        <TextField
          label={t('returns.checkIn.number')}
          ltr
          value={number}
          onChange={(event) => setNumber(event.target.value)}
        />
      </div>
      <TextField
        label={t('returns.claim.note')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {wrong && <Alert tone="danger">{t('orderReturns.tooMany')}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={create.isPending} disabled={!ready}>
          {t('orderReturns.record')}
        </Button>
        <Button variant="tertiary" onClick={() => onDone('')}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

function ReturnItem({
  back,
  order,
  timezone,
  works,
}: {
  back: ReturnDetail;
  order: OrderDetail;
  timezone: string;
  works: boolean;
}) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const [open, setOpen] = useState<'checkIn' | null>(null);
  const receive = useAdminMutation<ParcelUserErrorsData, { id: string; restock: Restock }>(
    ReturnReceiveMutation,
  );
  const cancel = useAdminMutation<ParcelUserErrorsData, { id: string }>(ReturnCancelMutation);
  const { problem, attempt } = useAttempt();
  const badge = STATUS_BADGES[back.status];
  const titles = new Map(order.lineItems.map((line) => [line.id, line]));
  const tracking = trackingText(back.trackingInfo);

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="num min-w-0 flex-1 font-medium">{back.name}</span>
        <Badge colour={badge.colour} icon={badge.icon} label={t(badge.label)} />
      </div>
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {formatDate(back.createdAt, timezone, locale)}
        {tracking && (
          <>
            {' · '}
            <span dir="ltr">{tracking}</span>
          </>
        )}
      </span>
      <ul className="flex flex-col">
        {back.returnLineItems.map((each) => {
          const line = titles.get(each.lineItem.id);
          return (
            <li key={each.lineItem.id} className="flex flex-col">
              <span dir="auto">
                {formatCount(each.quantity)} × {line?.title}
                {line && line.variantTitle !== 'Default Title' ? ` (${line.variantTitle})` : ''}
              </span>
              <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {t(`orderReturns.reason.${each.returnReason}` as MessageKey)}
                {each.restockedQuantity !== null &&
                  ` · ${t('orderReturns.restocked', {
                    count: formatCount(each.restockedQuantity),
                    off: formatCount(each.quantity - each.restockedQuantity),
                  })}`}
              </span>
            </li>
          );
        })}
      </ul>
      {back.exchangeOrder && (
        <span>
          {t('orderReturns.exchangeSent')}{' '}
          <Link
            to="/$shopId/orders/$orderId"
            params={{ shopId, orderId: back.exchangeOrder.id }}
            className="num underline"
          >
            {back.exchangeOrder.name}
          </Link>
        </span>
      )}
      {back.note && (
        <span className="text-secondary" dir="auto">
          {back.note}
        </span>
      )}
      {works && back.status === 'OPEN' && open === 'checkIn' && (
        <RestockForm
          lines={back.returnLineItems.map((each) => ({
            id: each.lineItem.id,
            title: titles.get(each.lineItem.id)?.title ?? '',
            variantTitle: titles.get(each.lineItem.id)?.variantTitle ?? null,
            quantity: each.quantity,
          }))}
          busy={receive.isPending}
          problem={problem}
          onCancel={() => setOpen(null)}
          onSubmit={(restock) =>
            void attempt(
              async () => (await receive.mutateAsync({ id: back.id, restock })).returnReceive!,
            ).then((done) => done && setOpen(null))
          }
        />
      )}
      {works && back.status === 'OPEN' && open === null && (
        <>
          {problem && <Alert tone="danger">{problem}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setOpen('checkIn')}>{t('parcels.checkIn')}</Button>
            <Button
              variant="danger"
              busy={cancel.isPending}
              onClick={() =>
                void attempt(async () => (await cancel.mutateAsync({ id: back.id })).returnCancel!)
              }
            >
              {t('orderReturns.kept')}
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

/**
 * An order's customer returns (ORD-07, ADR-136, ADR-137): each with its items and why, on its
 * way, received with what went back in stock, or cancelled; a return recorded from what was
 * delivered, another variant sent at once in exchange; checked in or cancelled while it comes.
 * Shown where the order has returns, or something delivered that could come back.
 */
export function OrderReturns({ order, timezone }: { order: OrderDetail; timezone: string }) {
  const { t } = useLocale();
  const { role } = useShop();
  const [recording, setRecording] = useState(false);
  const [done, setDone] = useState('');
  const works = WORKS_PARCELS.includes(role);
  const left = returnable(order);
  const canReturn = works && [...left.values()].some((count) => count > 0);

  return (
    <div className="flex flex-col gap-3">
      {order.returns.length === 0 && !recording && (
        <p className="text-secondary">{t('orderReturns.none')}</p>
      )}
      {order.returns.length > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {order.returns.map((back) => (
            <ReturnItem key={back.id} back={back} order={order} timezone={timezone} works={works} />
          ))}
        </ul>
      )}
      {done && <Alert tone="success">{done}</Alert>}
      {recording ? (
        <RecordReturn
          order={order}
          left={left}
          onDone={(message) => {
            setRecording(false);
            setDone(message);
          }}
        />
      ) : (
        canReturn && (
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => {
              setDone('');
              setRecording(true);
            }}
          >
            {t('orderReturns.start')}
          </Button>
        )
      )}
    </div>
  );
}
