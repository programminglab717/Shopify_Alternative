import { Ban, Check, CircleCheck, Clock, CreditCard, Landmark, Wallet } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  BillingCreditsBuyMutation,
  BillingInvoicePayMutation,
  BillingInvoiceTransferReportMutation,
  BillingPlanChangeMutation,
  BillingQuery,
  BillingWalletEntriesQuery,
} from '../api/operations';
import type {
  BillingData,
  BillingInterval,
  BillingInvoiceValue,
  BillingPlanValue,
  BillingWalletEntriesData,
  BillingWalletEntryValue,
  UserError,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatDate, formatDateTime, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { Problems, SelectField } from './settings-form';
import { BackToSettings } from './settings-page';

type Recent = ReturnType<typeof useRecentAuthentication>['run'];

/** What one of a plan's limits allows, in a line. */
function planLines(plan: BillingPlanValue, t: ReturnType<typeof useLocale>['t']): string[] {
  return [
    plan.orderLimit === null
      ? t('billing.ordersAny')
      : t('billing.orders', { count: plan.orderLimit }),
    t('billing.staff', { count: plan.staffLimit }),
    t('billing.locations', { count: plan.locationLimit }),
    t(plan.onlineGateways ? 'billing.gatewaysYes' : 'billing.gatewaysNo'),
    t(plan.customDomains ? 'billing.domainYes' : 'billing.domainNo'),
  ];
}

/**
 * An invoice waiting to be paid: through Hatti's gateway, whose page the owner is sent to, or by
 * transfer or Raast into Hatti's account, its reference then given for Hatti's people to find.
 */
function InvoiceToPay({
  invoice,
  bank,
  owner,
  run,
}: {
  invoice: BillingInvoiceValue;
  bank: BillingData['billingBankAccount'];
  owner: boolean;
  run: Recent;
}) {
  const { t } = useLocale();
  const pay = useAdminMutation<
    { billingInvoicePay: { checkoutUrl: string | null; userErrors: UserError[] } },
    { id: string }
  >(BillingInvoicePayMutation);
  const report = useAdminMutation<
    { billingInvoiceTransferReport: { userErrors: UserError[] } },
    { id: string; reference: string }
  >(BillingInvoiceTransferReportMutation);
  const [reference, setReference] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const latest = invoice.transfers[0];
  const onError = (failure: unknown) => setProblems([errorText(failure, t)]);

  const onPay = () => {
    setProblems([]);
    void run(async () => {
      const { billingInvoicePay } = await pay.mutateAsync({ id: invoice.id });
      if (billingInvoicePay.checkoutUrl) window.location.assign(billingInvoicePay.checkoutUrl);
      else setProblems(billingInvoicePay.userErrors.map((error) => problemText(error, t)));
    }, onError);
  };

  const onReport = (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    void run(async () => {
      const { billingInvoiceTransferReport } = await report.mutateAsync({
        id: invoice.id,
        reference: reference.trim(),
      });
      setProblems(billingInvoiceTransferReport.userErrors.map((error) => problemText(error, t)));
      if (billingInvoiceTransferReport.userErrors.length === 0) setReference('');
    }, onError);
  };

  return (
    <Card className="flex flex-col gap-4 border-warning p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">
          {t('billing.toPay', { name: invoice.name, amount: formatMoney(invoice.amount.amount) })}
        </h3>
        <span className="text-secondary">
          {t(`billing.reason.${invoice.reason}` as MessageKey, { plan: invoice.plan?.name ?? '' })}
        </span>
      </div>
      {latest?.status === 'WAITING' && (
        <Alert tone="info">{t('billing.transferWaiting', { reference: latest.reference })}</Alert>
      )}
      {latest?.status === 'REFUSED' && (
        <Alert tone="danger">
          {t('billing.transferRefused', {
            reference: latest.reference,
            refusal: latest.refusal ?? '',
          })}
        </Alert>
      )}
      {!owner ? (
        <p className="text-secondary">{t('billing.ownerPays')}</p>
      ) : (
        <>
          <Button
            icon={<CreditCard aria-hidden className="size-5" />}
            busy={pay.isPending}
            className="self-start"
            onClick={onPay}
          >
            {t('billing.payOnline')}
          </Button>
          {bank && latest?.status !== 'WAITING' && (
            <form onSubmit={onReport} className="flex flex-col gap-3 border-t border-line pt-4">
              <p className="flex items-center gap-2 font-medium">
                <Landmark aria-hidden className="size-5 text-secondary" />
                {t('billing.byTransfer')}
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-secondary">{t('transfer.bankName')}</dt>
                <dd>{bank.bankName}</dd>
                <dt className="text-secondary">{t('transfer.title')}</dt>
                <dd>{bank.title}</dd>
                <dt className="text-secondary">{t('transfer.iban')}</dt>
                <dd className="num break-all" dir="ltr">
                  {bank.iban.replace(/(.{4})(?=.)/g, '$1 ')}
                </dd>
                {bank.raastId && (
                  <>
                    <dt className="text-secondary">{t('billing.raast')}</dt>
                    <dd className="num" dir="ltr">
                      {bank.raastId}
                    </dd>
                  </>
                )}
              </dl>
              <p>{t('billing.purpose', { name: invoice.name })}</p>
              <TextField
                label={t('billing.reference')}
                hint={t('billing.referenceHint')}
                required
                minLength={4}
                maxLength={64}
                ltr
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
              <Button
                type="submit"
                variant="secondary"
                busy={report.isPending}
                className="self-start"
              >
                {t('billing.reportTransfer')}
              </Button>
            </form>
          )}
        </>
      )}
      <Problems problems={problems} />
    </Card>
  );
}

function Plans({ data, owner, run }: { data: BillingData; owner: boolean; run: Recent }) {
  const { t } = useLocale();
  const change = useAdminMutation<
    { billingPlanChange: { userErrors: UserError[] } },
    { input: { plan: string; interval?: BillingInterval } }
  >(BillingPlanChangeMutation);
  const current = data.billingSubscription;
  const [interval, setInterval] = useState<BillingInterval>(current.interval ?? 'MONTHLY');
  const [problems, setProblems] = useState<string[]>([]);

  const onChoose = (plan: BillingPlanValue) => {
    setProblems([]);
    void run(
      async () => {
        const { billingPlanChange } = await change.mutateAsync({
          input: { plan: plan.code, ...(plan.code !== 'FREE' && { interval }) },
        });
        setProblems(billingPlanChange.userErrors.map((error) => problemText(error, t)));
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  };

  return (
    <FormSection title={t('billing.plans')}>
      <SelectField
        label={t('billing.interval')}
        value={interval}
        options={[
          { value: 'MONTHLY', label: t('billing.monthly') },
          { value: 'YEARLY', label: t('billing.yearly') },
        ]}
        onChange={setInterval}
      />
      <ul className="grid gap-3 md:grid-cols-2">
        {data.billingPlans.map((plan) => {
          const mine = plan.code === current.plan.code;
          const price = interval === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice;
          return (
            <li
              key={plan.code}
              className={`flex flex-col gap-3 rounded-control border p-4 ${
                mine ? 'border-primary' : 'border-line'
              }`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{plan.name}</span>
                <span className="num">
                  {plan.code === 'FREE'
                    ? t('billing.free')
                    : t(interval === 'YEARLY' ? 'billing.perYear' : 'billing.perMonth', {
                        price: formatMoney(price.amount),
                      })}
                </span>
              </div>
              <ul className="flex flex-col gap-1 text-secondary">
                {planLines(plan, t).map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
                    {line}
                  </li>
                ))}
              </ul>
              {mine && (
                <span className="self-start">
                  <Badge colour="delivered" icon={CircleCheck} label={t('billing.yourPlan')} />
                </span>
              )}
              {owner &&
                (!mine || current.nextPlan || (current.interval ?? interval) !== interval) && (
                  <Button
                    variant="secondary"
                    busy={change.isPending && change.variables?.input.plan === plan.code}
                    className="self-start"
                    onClick={() => onChoose(plan)}
                  >
                    {/* The current plan chosen again keeps it, dropping a change chosen for later. */}
                    {t(
                      mine && (current.interval ?? interval) === interval
                        ? 'billing.keep'
                        : 'billing.choose',
                      {
                        plan: plan.name,
                      },
                    )}
                  </Button>
                )}
            </li>
          );
        })}
      </ul>
      <Problems problems={problems} />
    </FormSection>
  );
}

/** The most of the credit's changes the core lists. */
const MOST_ENTRIES = 100;

/** What a change to the credit was, in the merchant's words. */
function entryText(entry: BillingWalletEntryValue, t: Translate): string {
  const channel = entry.channel ? t(`messages.channel.${entry.channel}` as MessageKey) : '';
  switch (entry.kind) {
    case 'TOP_UP':
      return t('wallet.kind.TOP_UP');
    case 'GRANT':
      return entry.note
        ? t('wallet.kind.GRANT_NOTE', { note: entry.note })
        : t('wallet.kind.GRANT');
    case 'MESSAGE_REFUND':
      return t('wallet.kind.MESSAGE_REFUND', { channel });
    case 'MESSAGE': {
      const what = entry.category
        ? t(`wallet.category.${entry.category}` as MessageKey)
        : t('wallet.category.OTHER');
      return entry.parts && entry.parts > 1
        ? t('wallet.kind.MESSAGE_PARTS', { channel, what, parts: String(entry.parts) })
        : t('wallet.kind.MESSAGE', { channel, what });
    }
  }
}

/**
 * What changed the shop's message credit, the newest first (BIL-03, ADR-155): credit bought or
 * given by Hatti, each message paid for at its price, and what an undelivered WhatsApp message
 * was given back; with what the credit held after each. The latest 20, then up to 100.
 */
function CreditHistory() {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const [first, setFirst] = useState(20);
  const query = useAdminQuery<BillingWalletEntriesData>(
    ['billingWalletEntries'],
    BillingWalletEntriesQuery,
    { first },
    { keepPrevious: true },
  );

  if (query.isPending) return <p className="text-secondary">{t('state.loading')}</p>;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const entries = query.data.billingWalletEntries;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="font-medium">{t('wallet.history')}</h3>
      {entries.length === 0 ? (
        <p className="text-secondary">{t('wallet.none')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {entries.map((entry) => {
            const added = Number(entry.amount.amount) > 0;
            return (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="min-w-0 flex-1">{entryText(entry, t)}</span>
                <span className={`num font-medium ${added ? 'text-success' : ''}`}>
                  {added ? '+' : ''}
                  {formatMoney(entry.amount.amount)}
                </span>
                <span className="w-full text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {formatDateTime(entry.createdAt, timezone, locale)}
                  {' · '}
                  <span className="whitespace-nowrap">
                    {t('wallet.after', { amount: formatMoney(entry.balance.amount) })}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {entries.length === first && first < MOST_ENTRIES && (
        <Button
          variant="tertiary"
          className="self-start"
          busy={query.isFetching}
          onClick={() => setFirst(MOST_ENTRIES)}
        >
          {t('wallet.more')}
        </Button>
      )}
    </div>
  );
}

function Credit({ data, owner, run }: { data: BillingData; owner: boolean; run: Recent }) {
  const { t } = useLocale();
  const buy = useAdminMutation<
    { billingCreditsBuy: { userErrors: UserError[] } },
    { input: { amount: string } }
  >(BillingCreditsBuyMutation);
  const [amount, setAmount] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const wallet = data.billingWallet;

  const onBuy = (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    void run(
      async () => {
        const { billingCreditsBuy } = await buy.mutateAsync({
          input: { amount: amount.replace(/,/g, '').trim() },
        });
        setProblems(billingCreditsBuy.userErrors.map((error) => problemText(error, t)));
        if (billingCreditsBuy.userErrors.length === 0) setAmount('');
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  };

  return (
    <FormSection title={t('billing.credit')} hint={t('billing.creditHint')}>
      <p className="flex items-center gap-2">
        <Wallet aria-hidden className="size-5 text-secondary" />
        <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">
          {formatMoney(wallet.balance.amount)}
        </span>
      </p>
      {wallet.openInvoice && (
        <InvoiceToPay
          invoice={wallet.openInvoice}
          bank={data.billingBankAccount}
          owner={owner}
          run={run}
        />
      )}
      {owner && !wallet.openInvoice && (
        <form onSubmit={onBuy} className="flex flex-col gap-3">
          <TextField
            label={t('billing.buyAmount')}
            hint={t('billing.buyAmountHint')}
            inputMode="numeric"
            required
            ltr
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <Button type="submit" variant="secondary" busy={buy.isPending} className="self-start">
            {t('billing.buy')}
          </Button>
        </form>
      )}
      <Problems problems={problems} />
      <CreditHistory />
    </FormSection>
  );
}

const INVOICE_BADGES = {
  OPEN: { colour: 'needsConfirmation', icon: Clock },
  PAID: { colour: 'delivered', icon: CircleCheck },
  VOID: { colour: 'cancelled', icon: Ban },
} as const;

/**
 * The shop's plan with Hatti and what it pays (BIL-01, BIL-03, ADR-154, ADR-155, ADR-254): the plan
 * and its period, the plans to choose from, invoices paid through Hatti's gateway or by transfer or
 * Raast, and the credit its messages are paid from. Managers read it; the owner alone changes it,
 * having confirmed who they are lately, as the core asks.
 */
export function BillingPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const owner = shop.role === 'owner';
  const query = useAdminQuery<BillingData>(['billing'], BillingQuery);
  const { run, panel } = useRecentAuthentication();

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const data = query.data;
  const subscription = data.billingSubscription;
  const date = (iso: string) => formatDate(iso, timezone, locale);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.billing')}
      </h1>
      {panel}
      <FormSection title={t('billing.yourPlanTitle', { plan: subscription.plan.name })}>
        {subscription.pastDue && <Alert tone="danger">{t('billing.pastDue')}</Alert>}
        {subscription.periodEnd && (
          <p>
            {t(
              subscription.interval === 'YEARLY' ? 'billing.paidUntilYearly' : 'billing.paidUntil',
              { date: date(subscription.periodEnd) },
            )}
          </p>
        )}
        {subscription.nextPlan && subscription.periodEnd && (
          <p className="text-secondary">
            {t('billing.nextPlan', {
              plan: subscription.nextPlan.name,
              date: date(subscription.periodEnd),
            })}
          </p>
        )}
        {!owner && <p className="text-secondary">{t('billing.ownerChanges')}</p>}
        {subscription.openInvoice && (
          <InvoiceToPay
            invoice={subscription.openInvoice}
            bank={data.billingBankAccount}
            owner={owner}
            run={run}
          />
        )}
      </FormSection>
      <Plans data={data} owner={owner} run={run} />
      <Credit data={data} owner={owner} run={run} />
      {data.billingInvoices.length > 0 && (
        <FormSection title={t('billing.invoices')}>
          <ul className="divide-y divide-line">
            {data.billingInvoices.map((invoice) => (
              <li key={invoice.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="num font-medium">{invoice.name}</span>
                <span className="text-secondary">{date(invoice.createdAt)}</span>
                <span className="min-w-0 flex-1 text-secondary">
                  {t(`billing.reason.${invoice.reason}` as MessageKey, {
                    plan: invoice.plan?.name ?? '',
                  })}
                </span>
                <span className="num">{formatMoney(invoice.amount.amount)}</span>
                <Badge
                  {...INVOICE_BADGES[invoice.status]}
                  label={t(`billing.status.${invoice.status}` as MessageKey)}
                />
              </li>
            ))}
          </ul>
        </FormSection>
      )}
    </div>
  );
}
