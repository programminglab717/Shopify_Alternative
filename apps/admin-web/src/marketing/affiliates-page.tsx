import { Link } from '@tanstack/react-router';
import { CircleOff, Copy, Handshake, Link2, Tag } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  AffiliateActivityQuery,
  AffiliateCreateMutation,
  AffiliatePayoutRecordMutation,
  AffiliateUpdateMutation,
  AffiliatesQuery,
} from '../api/operations';
import type {
  AffiliateActivityData,
  AffiliatePayload,
  AffiliatesData,
  AffiliateValue,
  MoneyValue,
  UserError,
} from '../api/types';
import { errorText, userErrorText } from '../i18n/errors';
import { formatCount, formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { messages, type MessageKey } from '../i18n/messages';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** What an affiliate's form takes, as the API takes it. */
interface AffiliateDraft {
  name: string;
  phone: string;
  ref: string;
  discountCode: string;
  commission: string;
}

const BLANK: AffiliateDraft = { name: '', phone: '', ref: '', discountCode: '', commission: '10' };

/** The field a user error is about, by its last name: "name", "ref" and so on. */
const fieldOf = (error: UserError) => error.field?.at(-1) ?? '';

/** An affiliate's link: the shop's address with ?ref= and theirs. */
export function affiliateLink(shopUrl: string, ref: string): string {
  return `${shopUrl.replace(/\/+$/, '')}/?ref=${encodeURIComponent(ref)}`;
}

/** Adds an affiliate, or changes one: name, number, link, code and share. */
function AffiliateForm({ affiliate, onDone }: { affiliate?: AffiliateValue; onDone?: () => void }) {
  const { t } = useLocale();
  const create = useAdminMutation<{ affiliateCreate: AffiliatePayload }, { input: object }>(
    AffiliateCreateMutation,
  );
  const update = useAdminMutation<{ affiliateUpdate: AffiliatePayload }, { input: object }>(
    AffiliateUpdateMutation,
  );
  const [draft, setDraft] = useState<AffiliateDraft>(
    affiliate
      ? {
          name: affiliate.name,
          phone: affiliate.phone ?? '',
          ref: affiliate.ref,
          discountCode: affiliate.discountCode ?? '',
          commission: affiliate.commission,
        }
      : BLANK,
  );
  const [errors, setErrors] = useState<UserError[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const errorOn = (field: keyof AffiliateDraft) => {
    const error = errors.find((each) => fieldOf(each) === field);
    return error ? userErrorText(error, t) : null;
  };
  const set = (field: keyof AffiliateDraft) => (event: { target: { value: string } }) =>
    setDraft({ ...draft, [field]: event.target.value });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setErrors([]);
    try {
      const payload = affiliate
        ? (await update.mutateAsync({ input: { id: affiliate.id, ...draft } })).affiliateUpdate
        : (await create.mutateAsync({ input: draft })).affiliateCreate;
      if (payload.userErrors.length > 0) {
        setErrors(payload.userErrors);
        const other = payload.userErrors.find((each) => !(fieldOf(each) in BLANK));
        if (other) setProblem(userErrorText(other, t));
        return;
      }
      if (!affiliate) setDraft(BLANK);
      onDone?.();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('affiliates.name')}
          value={draft.name}
          maxLength={100}
          required
          onChange={set('name')}
          error={errorOn('name')}
        />
        <TextField
          label={t('affiliates.phone')}
          value={draft.phone}
          ltr
          inputMode="tel"
          placeholder="0300 1234567"
          onChange={set('phone')}
          error={errorOn('phone')}
        />
        <TextField
          label={t('affiliates.ref')}
          hint={t('affiliates.refHint')}
          value={draft.ref}
          ltr
          maxLength={40}
          required
          autoComplete="off"
          onChange={set('ref')}
          error={errorOn('ref')}
        />
        <TextField
          label={t('affiliates.code')}
          hint={t('affiliates.codeHint')}
          value={draft.discountCode}
          ltr
          maxLength={50}
          autoComplete="off"
          onChange={set('discountCode')}
          error={errorOn('discountCode')}
        />
        <TextField
          label={t('affiliates.share')}
          hint={t('affiliates.shareHint')}
          value={draft.commission}
          ltr
          inputMode="decimal"
          required
          onChange={set('commission')}
          error={errorOn('commission')}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={create.isPending || update.isPending}>
          {affiliate ? t('affiliates.save') : t('affiliates.add')}
        </Button>
        {affiliate && (
          <Button variant="tertiary" onClick={onDone}>
            {t('affiliates.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Records what the shop paid an affiliate. */
function PayoutForm({ affiliate, onDone }: { affiliate: AffiliateValue; onDone: () => void }) {
  const { t } = useLocale();
  const record = useAdminMutation<
    { affiliatePayoutRecord: { payout: { id: string } | null; userErrors: UserError[] } },
    { input: object }
  >(AffiliatePayoutRecordMutation);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { affiliatePayoutRecord } = await record.mutateAsync({
        input: { affiliateId: affiliate.id, amount, note },
      });
      const error = affiliatePayoutRecord.userErrors[0];
      if (error) setProblem(userErrorText(error, t));
      else onDone();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="flex flex-col gap-3 rounded-control border border-line p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('affiliates.payoutAmount')}
          value={amount}
          ltr
          inputMode="decimal"
          required
          onChange={(event) => setAmount(event.target.value)}
        />
        <TextField
          label={t('affiliates.payoutNote')}
          hint={t('affiliates.payoutNoteHint')}
          value={note}
          maxLength={200}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={record.isPending}>
          {t('affiliates.payoutRecord')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('affiliates.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** An order's stage in words, as the orders list says it. */
function useStage() {
  const { t } = useLocale();
  return (stage: string) => {
    const key = `stage.${stage.toUpperCase()}`;
    return key in messages.en ? t(key as MessageKey) : stage;
  };
}

/** An affiliate's latest orders, with what each earns them, and what the shop paid them. */
function Activity({ affiliate }: { affiliate: AffiliateValue }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const shopId = useShop().id;
  const stage = useStage();
  const query = useAdminQuery<AffiliateActivityData>(
    ['affiliateActivity', affiliate.id],
    AffiliateActivityQuery,
    { id: affiliate.id },
  );
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const { affiliateOrders, affiliatePayouts } = query.data;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-medium">{t('affiliates.orders')}</h3>
      {affiliateOrders.length === 0 ? (
        <p className="text-secondary">{t('affiliates.noOrders')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
          {affiliateOrders.map((order) => (
            <li key={order.orderId} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
              <Link
                to="/$shopId/orders/$orderId"
                params={{ shopId, orderId: order.orderId }}
                className="font-medium text-primary hover:underline"
              >
                {order.name}
              </Link>
              <span className="text-secondary">
                {formatDate(order.placedAt, timezone, locale)} · {stage(order.stage)} ·{' '}
                {order.source === 'CODE' ? t('affiliates.byCode') : t('affiliates.byLink')}
              </span>
              <span className="num ms-auto">
                {t('affiliates.orderEarns', {
                  base: money(order.base),
                  commission: money(order.commission),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="font-medium">{t('affiliates.payouts')}</h3>
      {affiliatePayouts.length === 0 ? (
        <p className="text-secondary">{t('affiliates.noPayouts')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
          {affiliatePayouts.map((payout) => (
            <li key={payout.id} className="flex flex-wrap gap-x-3 gap-y-1 p-3">
              <span className="num font-medium">{money(payout.amount)}</span>
              <span className="text-secondary">
                {formatDate(payout.paidAt, timezone, locale)}
                {payout.note && ` · ${payout.note}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const money = (value: MoneyValue) => formatMoney(value.amount, value.currencyCode);

/** An affiliate: their link and code, their figures, and what can be done. */
function AffiliateCard({ affiliate, shopUrl }: { affiliate: AffiliateValue; shopUrl: string }) {
  const { t } = useLocale();
  const update = useAdminMutation<{ affiliateUpdate: AffiliatePayload }, { input: object }>(
    AffiliateUpdateMutation,
  );
  const [open, setOpen] = useState<'edit' | 'payout' | 'activity' | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const link = affiliateLink(shopUrl, affiliate.ref);
  const { stats } = affiliate;
  const toggle = (panel: 'edit' | 'payout' | 'activity') => setOpen(open === panel ? null : panel);

  const setActive = async (active: boolean) => {
    setProblem(null);
    try {
      const { affiliateUpdate } = await update.mutateAsync({
        input: { id: affiliate.id, active },
      });
      if (affiliateUpdate.userErrors[0]) {
        setProblem(userErrorText(affiliateUpdate.userErrors[0], t));
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const figures: [string, string][] = [
    [
      t('affiliates.figureOrders'),
      t('affiliates.ordersDelivered', {
        orders: formatCount(stats.orders),
        delivered: formatCount(stats.delivered),
      }),
    ],
    [t('affiliates.figureSales'), money(stats.sales)],
    [t('affiliates.figureEarned'), money(stats.earned)],
    [t('affiliates.figurePending'), money(stats.pending)],
    [t('affiliates.figurePaid'), money(stats.paid)],
    [t('affiliates.figureOwed'), money(stats.owed)],
  ];

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold" dir="auto">
          {affiliate.name}
        </h2>
        <span className="text-secondary">
          {t('affiliates.shareOf', { share: affiliate.commission })}
        </span>
        {!affiliate.active && (
          <Badge colour="cancelled" icon={CircleOff} label={t('affiliates.ended')} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link2 aria-hidden className="size-5 text-secondary" />
        <span dir="ltr" className="min-w-0 break-all">
          {link}
        </span>
        <Button
          variant="tertiary"
          icon={<Copy aria-hidden className="size-5" />}
          onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}
        >
          {copied ? t('staff.copied') : t('staff.copy')}
        </Button>
      </div>
      {affiliate.discountCode && (
        <p className="flex items-center gap-2">
          <Tag aria-hidden className="size-5 text-secondary" />
          <span dir="ltr" className="font-medium">
            {affiliate.discountCode}
          </span>
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {figures.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">{label}</dt>
            <dd className="num font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => toggle('payout')}>
          {t('affiliates.payoutRecord')}
        </Button>
        <Button
          variant="secondary"
          aria-expanded={open === 'activity'}
          onClick={() => toggle('activity')}
        >
          {t('affiliates.showActivity')}
        </Button>
        <Button variant="tertiary" onClick={() => toggle('edit')}>
          {t('affiliates.edit')}
        </Button>
        <Button
          variant="tertiary"
          busy={update.isPending}
          onClick={() => void setActive(!affiliate.active)}
        >
          {affiliate.active ? t('affiliates.end') : t('affiliates.resume')}
        </Button>
      </div>
      {open === 'payout' && <PayoutForm affiliate={affiliate} onDone={() => setOpen(null)} />}
      {open === 'edit' && <AffiliateForm affiliate={affiliate} onDone={() => setOpen(null)} />}
      {open === 'activity' && <Activity affiliate={affiliate} />}
    </Card>
  );
}

/**
 * Affiliates and influencers (MKT-08, ADR-777): the people who bring the shop customers by a link
 * or code of their own, each with what their orders came to, what they earned once delivered and
 * what is owed; the shop adds them, records what it paid them, and ends their part.
 */
export function AffiliatesPage() {
  const { t } = useLocale();
  const query = useAdminQuery<AffiliatesData>(['affiliates'], AffiliatesQuery);
  const affiliates = query.data?.affiliates ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Handshake aria-hidden className="size-7 text-secondary" />
        {t('affiliates.title')}
      </h1>
      <p className="text-secondary">{t('affiliates.intro')}</p>
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="font-semibold">{t('affiliates.new')}</h2>
        <AffiliateForm />
      </Card>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : affiliates.length === 0 ? (
        <EmptyState title={t('affiliates.none')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {affiliates.map((affiliate) => (
            <li key={affiliate.id}>
              <AffiliateCard affiliate={affiliate} shopUrl={query.data.shop.url} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
