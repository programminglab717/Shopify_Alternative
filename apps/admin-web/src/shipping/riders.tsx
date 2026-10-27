import { Link } from '@tanstack/react-router';
import { Bike, KeyRound, Plus, Send, Wallet } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  RiderCreateMutation,
  RiderDetailQuery,
  RiderHandOutMutation,
  RiderHandOverMutation,
  RiderNewLinkMutation,
  RiderUpdateMutation,
  RidersQuery,
} from '../api/operations';
import type {
  OrderListItem,
  RiderCreateData,
  RiderDetailData,
  RiderHandOutData,
  RiderHandOverData,
  RiderNewLinkData,
  RiderSaved,
  RiderUpdateData,
  RiderValue,
  RidersData,
} from '../api/types';
import { gate, permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatDateTime, formatMoney, formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, problemText } from '../products/product-form';
import { CheckField, SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import type { ShippedByHand } from './by-hand';

/** Riders are the shop's people: owners and managers add and change them (ADR-824). */
export const MANAGES_RIDERS = gate(['owner', 'manager'], 'manage_staff');

/** Riders' cash is reconciled by owners, managers and accountants (ADR-826). */
export const TAKES_RIDERS_CASH = gate(['owner', 'manager', 'accountant'], 'reconcile_payments');

/** A message to send a rider their page's link on WhatsApp, in both languages. */
function linkMessage(shop: string, link: string): string {
  return (
    `${shop}: your deliveries are on this page. Keep it to yourself. ` +
    `آپ کی ڈیلیوریز اس صفحے پر ہیں۔ اسے کسی کو نہ دیں۔ ${link}`
  );
}

/**
 * Packed orders handed to one of the shop's riders who ride now (ADR-827), each shipped with them
 * and its customer sent a code for the door; those the core refuses stay packed, said by name.
 */
export function HandToRider({
  orders,
  onDone,
  onCancel,
}: {
  orders: readonly OrderListItem[];
  onDone: (outcome: ShippedByHand) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const riders = useAdminQuery<RidersData>(['riders'], RidersQuery);
  const handOut = useAdminMutation<RiderHandOutData, { riderId: string; orderIds: string[] }>(
    RiderHandOutMutation,
  );
  const active = (riders.data?.riders ?? []).filter((rider) => rider.active);
  const [riderId, setRiderId] = useState('');
  const chosen = riderId || active[0]?.id || '';
  const names = new Map(orders.map((order) => [order.id, order.name]));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const { riderHandOut } = await handOut.mutateAsync({
        riderId: chosen,
        orderIds: orders.map((order) => order.id),
      });
      onDone({
        shipped: riderHandOut.results.filter((result) => result.delivery).length,
        refused: [
          ...riderHandOut.results
            .filter((result) => result.problem)
            .map((result) => `${names.get(result.orderId) ?? ''}: ${result.problem}`),
          ...riderHandOut.userErrors.map((error) => error.message),
        ],
      });
    } catch (failure) {
      onDone({ shipped: 0, refused: [errorText(failure, t)] });
    }
  };

  if (riders.isPending) return <Loading label={t('state.loading')} />;
  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <h2 className="font-semibold">{t('riders.handOutTitle', { count: orders.length })}</h2>
        {active.length === 0 ? (
          <Alert tone="info">{t('riders.noneActive')}</Alert>
        ) : (
          <SelectField<string>
            label={t('riders.rider')}
            value={chosen}
            options={active.map((rider) => ({ value: rider.id, label: rider.name }))}
            onChange={setRiderId}
          />
        )}
        <p className="text-secondary">{t('riders.handOutHint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            busy={handOut.isPending}
            disabled={chosen === ''}
            icon={<Bike aria-hidden className="size-5" />}
          >
            {t('riders.handOut')}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t('riders.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The link a rider was just given, to copy or send them on WhatsApp: shown this once. */
function GivenLink({ rider, link }: { rider: RiderValue; link: string }) {
  const { t } = useLocale();
  const shop = useShop();
  const whatsapp = `https://wa.me/${rider.phone.replace(/^\+/, '')}?text=${encodeURIComponent(
    linkMessage(shop.name, link),
  )}`;
  return (
    <Alert tone="success">
      <p>{t('riders.linkOnce', { name: rider.name })}</p>
      <p dir="ltr" className="num break-all">
        {link}
      </p>
      <a
        href={whatsapp}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-2 underline"
      >
        <Send aria-hidden className="size-4" />
        {t('riders.sendLink')}
      </a>
    </Alert>
  );
}

/** A rider: what they carry and hold, their deliveries, and the cash they hand over. */
function RiderCard({ rider }: { rider: RiderValue }) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const manages = permits(shop, MANAGES_RIDERS);
  const takesCash = permits(shop, TAKES_RIDERS_CASH);
  const [open, setOpen] = useState(false);
  const [given, setGiven] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const detail = useAdminQuery<RiderDetailData>(
    ['riderDetail', rider.id],
    RiderDetailQuery,
    { riderId: rider.id, cash: takesCash },
    { enabled: open },
  );
  const update = useAdminMutation<RiderUpdateData, Record<string, unknown>>(RiderUpdateMutation);
  const newLink = useAdminMutation<RiderNewLinkData, { id: string }>(RiderNewLinkMutation);
  const handOver = useAdminMutation<RiderHandOverData, Record<string, unknown>>(
    RiderHandOverMutation,
  );
  const when = (iso: string) => formatDateTime(iso, timezone, locale);

  const attempt = async (action: () => Promise<{ userErrors: { message: string }[] }>) => {
    setProblem(null);
    try {
      const { userErrors } = await action();
      if (userErrors[0]) setProblem(userErrors[0].message);
      return userErrors.length === 0;
    } catch (failure) {
      setProblem(errorText(failure, t));
      return false;
    }
  };

  const onHandOver = async (event: FormEvent) => {
    event.preventDefault();
    const done = await attempt(async () => {
      const { riderHandOver } = await handOver.mutateAsync({
        riderId: rider.id,
        input: { amount: amount.replace(/,/g, '').trim(), note: note.trim() || null },
      });
      return riderHandOver;
    });
    if (done) {
      setAmount('');
      setNote('');
    }
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium" dir="auto">
          {rider.name}
          {!rider.active && <span className="text-secondary"> · {t('riders.inactive')}</span>}
        </span>
        <span dir="ltr" className="num text-secondary">
          {formatPhone(rider.phone)}
        </span>
      </div>
      <span className="text-secondary">
        {t('riders.summary', {
          out: rider.out,
          cash: formatMoney(rider.cashHeld.amount, rider.cashHeld.currencyCode),
        })}
      </span>
      {given && <GivenLink rider={rider} link={given} />}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setOpen(!open)}>
          {open ? t('riders.hide') : t('riders.show')}
        </Button>
        {manages && (
          <>
            <Button
              variant="secondary"
              busy={newLink.isPending}
              icon={<KeyRound aria-hidden className="size-5" />}
              onClick={() =>
                void attempt(async () => {
                  const { riderNewLink } = await newLink.mutateAsync({ id: rider.id });
                  setGiven(riderNewLink.link);
                  return riderNewLink;
                })
              }
            >
              {t('riders.newLink')}
            </Button>
            <Button
              variant="secondary"
              busy={update.isPending}
              onClick={() =>
                void attempt(async () => {
                  const { riderUpdate } = await update.mutateAsync({
                    id: rider.id,
                    input: { name: rider.name, phone: rider.phone, active: !rider.active },
                  });
                  return riderUpdate;
                })
              }
            >
              {rider.active ? t('riders.deactivate') : t('riders.activate')}
            </Button>
          </>
        )}
      </div>
      {open &&
        (detail.isPending ? (
          <Loading label={t('state.loading')} />
        ) : detail.isError ? (
          <ErrorState message={errorText(detail.error, t)} />
        ) : (
          <>
            <h3 className="font-medium">{t('riders.deliveries')}</h3>
            {detail.data.riderDeliveries.length === 0 ? (
              <p className="text-secondary">{t('riders.noDeliveries')}</p>
            ) : (
              <ul
                aria-label={t('riders.deliveries')}
                className="flex flex-col divide-y divide-line"
              >
                {detail.data.riderDeliveries.map((delivery) => (
                  <li key={delivery.id} className="flex flex-wrap items-baseline gap-2 py-2">
                    <Link
                      to="/$shopId/orders/$orderId"
                      params={{ shopId: shop.id, orderId: delivery.orderId }}
                      className="underline-offset-4 hover:underline"
                    >
                      {t(`riders.status.${delivery.status}` as MessageKey)}
                    </Link>
                    <span className="text-secondary">{when(delivery.createdAt)}</span>
                    <span className="num">
                      {formatMoney(
                        delivery.status === 'DELIVERED'
                          ? delivery.cashCollected.amount
                          : delivery.cashDue.amount,
                        delivery.cashDue.currencyCode,
                      )}
                    </span>
                    {delivery.status === 'DELIVERED' && (
                      <span className="text-secondary">
                        {delivery.codeGiven
                          ? t('riders.codeGiven')
                          : delivery.codeSent
                            ? t('riders.codeNotGiven')
                            : t('riders.noCode')}
                      </span>
                    )}
                    {delivery.failedReason && (
                      <span className="text-secondary">{delivery.failedReason}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {takesCash && (
              <>
                <form onSubmit={(event) => void onHandOver(event)} className="flex flex-col gap-2">
                  <h3 className="font-medium">{t('riders.handOver')}</h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    <TextField
                      label={t('riders.amount')}
                      inputMode="decimal"
                      ltr
                      required
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                    <TextField
                      label={t('riders.note')}
                      dir="auto"
                      maxLength={500}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    className="self-start"
                    busy={handOver.isPending}
                    icon={<Wallet aria-hidden className="size-5" />}
                  >
                    {t('riders.handOverSave')}
                  </Button>
                </form>
                {(detail.data.riderHandovers ?? []).length > 0 && (
                  <ul aria-label={t('riders.handovers')} className="flex flex-col gap-1">
                    {detail.data.riderHandovers!.map((each) => (
                      <li key={each.id} className="text-secondary">
                        {when(each.createdAt)} ·{' '}
                        <span className="num">
                          {formatMoney(each.amount.amount, each.amount.currencyCode)}
                        </span>
                        {each.note && <span dir="auto"> · {each.note}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        ))}
    </Card>
  );
}

/** A rider added: their name and mobile; their page's link given this once. */
function NewRider({ onMade }: { onMade: (saved: RiderSaved) => void }) {
  const { t } = useLocale();
  const create = useAdminMutation<RiderCreateData, Record<string, unknown>>(RiderCreateMutation);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { riderCreate } = await create.mutateAsync({ input: { name: name.trim(), phone } });
      const error = riderCreate.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      setName('');
      setPhone('');
      onMade(riderCreate);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('riders.new')} hint={t('riders.newHint')}>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label={t('riders.name')}
            required
            dir="auto"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            label={t('riders.phone')}
            required
            inputMode="tel"
            ltr
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={create.isPending}
          icon={<Plus aria-hidden className="size-5" />}
        >
          {t('riders.add')}
        </Button>
      </form>
    </FormSection>
  );
}

/**
 * The shop's own riders (SHP-10, APP-06, ADR-827): each with what they carry and the cash they
 * hold, their deliveries and hand-overs; added, given a new link and made inactive by owners and
 * managers, their cash taken by those who reconcile payments.
 */
export function Riders() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<RidersData>(['riders'], RidersQuery);
  const [made, setMade] = useState<RiderSaved | null>(null);
  const [inactive, setInactive] = useState(false);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const riders = query.data.riders.filter((rider) => inactive || rider.active);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-secondary">{t('riders.intro')}</p>
      {permits(shop, MANAGES_RIDERS) && <NewRider onMade={setMade} />}
      {made?.rider && made.link && <GivenLink rider={made.rider} link={made.link} />}
      {query.data.riders.some((rider) => !rider.active) && (
        <CheckField label={t('riders.showInactive')} checked={inactive} onChange={setInactive} />
      )}
      {riders.length === 0 ? (
        <EmptyState title={t('riders.none')} body={t('riders.noneHint')} />
      ) : (
        <ul aria-label={t('riders.title')} className="flex flex-col gap-3">
          {riders.map((rider) => (
            <li key={rider.id}>
              <RiderCard rider={rider} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
