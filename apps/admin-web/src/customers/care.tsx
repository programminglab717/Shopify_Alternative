import { Link } from '@tanstack/react-router';
import { ArrowLeft, Download, GitMerge, Search, ShieldX, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CustomerDataExportMutation,
  CustomerErasureCancelMutation,
  CustomerErasureRequestMutation,
  CustomerErasureRequestsQuery,
  CustomerMarketingConsentUpdateMutation,
  CustomerMergeMutation,
  CustomersQuery,
} from '../api/operations';
import type {
  CustomerDataExportData,
  CustomerDetail,
  CustomerErasureCancelData,
  CustomerErasureRequestData,
  CustomerErasureRequestsData,
  CustomerMarketingConsentUpdateData,
  CustomerMergeData,
  CustomersData,
  MarketingChannel,
  MarketingState,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatDate, formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, problemText } from '../products/product-form';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { shownPhone } from './customers-page';

export const CHANNELS: readonly MarketingChannel[] = ['WHATSAPP', 'SMS', 'EMAIL'];

/** Whether each channel's consent is given, from the customer's record. */
function consentOf(customer: CustomerDetail): Record<MarketingChannel, MarketingState> {
  return {
    WHATSAPP: customer.whatsappMarketingConsent.marketingState,
    SMS: customer.smsMarketingConsent.marketingState,
    EMAIL: customer.emailMarketingConsent.marketingState,
  };
}

/**
 * What the customer agreed to be sent, by channel (CUS-04): ticked where they agreed. Agreeing
 * needs what they agreed to, as the shop asked them; each change goes into the consent ledger.
 */
export function MarketingConsent({ customer }: { customer: CustomerDetail }) {
  const { t } = useLocale();
  const update = useAdminMutation<
    CustomerMarketingConsentUpdateData,
    { id: string; marketingConsent: Record<string, unknown>[] }
  >(CustomerMarketingConsentUpdateMutation);
  const was = consentOf(customer);
  const [agreed, setAgreed] = useState(() =>
    Object.fromEntries(CHANNELS.map((channel) => [channel, was[channel] === 'SUBSCRIBED'])),
  );
  const [wording, setWording] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const changes = CHANNELS.filter((channel) => agreed[channel] !== (was[channel] === 'SUBSCRIBED'));
  const subscribing = changes.some((channel) => agreed[channel]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (changes.length === 0) return;
    if (subscribing && !wording.trim()) {
      setProblem(t('care.wordingNeeded'));
      return;
    }
    setProblem(null);
    setSaved(false);
    try {
      const { customerMarketingConsentUpdate } = await update.mutateAsync({
        id: customer.id,
        marketingConsent: changes.map((channel) => ({
          channel,
          marketingState: agreed[channel] ? 'SUBSCRIBED' : 'UNSUBSCRIBED',
          ...(agreed[channel] && { wording: wording.trim() }),
        })),
      });
      const error = customerMarketingConsentUpdate.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else {
        setWording('');
        setSaved(true);
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('care.consent')} hint={t('care.consentHint')}>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        {CHANNELS.map((channel) => (
          <CheckField
            key={channel}
            label={t(`care.channel.${channel}` as MessageKey)}
            hint={
              was[channel] === 'UNSUBSCRIBED' && !agreed[channel] ? t('care.withdrew') : undefined
            }
            checked={agreed[channel]!}
            onChange={(on) => setAgreed((all) => ({ ...all, [channel]: on }))}
          />
        ))}
        {subscribing && (
          <TextField
            label={t('care.wording')}
            hint={t('care.wordingHint')}
            dir="auto"
            value={wording}
            onChange={(event) => setWording(event.target.value)}
          />
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && changes.length === 0 && <Alert tone="success">{t('care.consentSaved')}</Alert>}
        <Button
          type="submit"
          variant="secondary"
          className="self-start"
          busy={update.isPending}
          disabled={changes.length === 0}
        >
          {t('care.saveConsent')}
        </Button>
      </form>
    </FormSection>
  );
}

/**
 * Another record of the same customer merged into this one: found by name or number, then
 * merged once staff say they mean it, since it cannot be undone.
 */
function Merge({ customer }: { customer: CustomerDetail }) {
  const { t } = useLocale();
  const [words, setWords] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{ id: string; displayName: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [merged, setMerged] = useState<string | null>(null);
  const found = useAdminQuery<CustomersData>(
    ['customers', 'merge', searched],
    CustomersQuery,
    { first: 10, query: searched },
    { enabled: searched !== null },
  );
  const merge = useAdminMutation<CustomerMergeData, { customerId: string; duplicateId: string }>(
    CustomerMergeMutation,
  );

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    setChosen(null);
    setSearched(words.trim() || null);
  };

  const onMerge = async () => {
    if (!chosen) return;
    setProblem(null);
    try {
      const { customerMerge } = await merge.mutateAsync({
        customerId: customer.id,
        duplicateId: chosen.id,
      });
      const error = customerMerge.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else {
        setMerged(chosen.displayName);
        setChosen(null);
        setSearched(null);
        setWords('');
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const others = (found.data?.customers.nodes ?? []).filter((each) => each.id !== customer.id);

  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-semibold">{t('care.merge')}</h3>
      <p className="text-secondary">{t('care.mergeHint')}</p>
      <form onSubmit={onSearch} role="search" className="flex flex-wrap items-end gap-2">
        <TextField
          label={t('care.findDuplicate')}
          type="search"
          dir="auto"
          className="min-w-48 flex-1"
          value={words}
          onChange={(event) => setWords(event.target.value)}
        />
        <Button type="submit" variant="secondary" icon={<Search aria-hidden className="size-5" />}>
          {t('care.find')}
        </Button>
      </form>
      {searched !== null &&
        (found.isPending ? (
          <Loading label={t('state.loading')} />
        ) : others.length === 0 ? (
          <p className="text-secondary">{t('care.noneFound')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {others.map((each) => (
              <li key={each.id}>
                <button
                  type="button"
                  aria-pressed={chosen?.id === each.id}
                  onClick={() => setChosen(each)}
                  className={`flex min-h-12 w-full flex-wrap items-center justify-between gap-x-3 rounded-control border px-3 text-start ${
                    chosen?.id === each.id ? 'border-primary' : 'border-line'
                  }`}
                >
                  <span className="font-medium" dir="auto">
                    {each.displayName}
                  </span>
                  <span className="num text-secondary" dir="ltr">
                    {shownPhone(each.phone)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
      {chosen && (
        <Alert tone="warning">
          <p>
            {t('care.mergeAsk', { duplicate: chosen.displayName, customer: customer.displayName })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={merge.isPending}
              icon={<GitMerge aria-hidden className="size-5" />}
              onClick={() => void onMerge()}
            >
              {t('care.mergeSure')}
            </Button>
            <Button variant="secondary" onClick={() => setChosen(null)}>
              {t('care.keepApart')}
            </Button>
          </div>
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {merged && <Alert tone="success">{t('care.merged', { duplicate: merged })}</Alert>}
    </div>
  );
}

/** A file the browser saves. */
function save(json: string, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * What a customer may ask of the shop under the law (CUS-05): everything it keeps of them, as a
 * file; and their erasure, ten days on so their orders can close and a mistake be undone, until
 * then cancelled. Both once the member confirms who they are.
 */
function Privacy({ customer }: { customer: CustomerDetail }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const { run, panel } = useRecentAuthentication();
  const exporting = useAdminMutation<CustomerDataExportData, { id: string }>(
    CustomerDataExportMutation,
  );
  const erase = useAdminMutation<CustomerErasureRequestData, { id: string }>(
    CustomerErasureRequestMutation,
  );
  const cancel = useAdminMutation<CustomerErasureCancelData, { id: string }>(
    CustomerErasureCancelMutation,
  );
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const fail = (failure: unknown) => setProblem(errorText(failure, t));

  const onExport = () => {
    setProblem(null);
    void run(async () => {
      const { customerDataExport } = await exporting.mutateAsync({ id: customer.id });
      const error = customerDataExport.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else if (customerDataExport.json && customerDataExport.fileName) {
        save(customerDataExport.json, customerDataExport.fileName);
        setExported(customerDataExport.fileName);
      }
    }, fail);
  };

  const onErase = () => {
    setProblem(null);
    void run(async () => {
      const { customerErasureRequest } = await erase.mutateAsync({ id: customer.id });
      const error = customerErasureRequest.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else setAsking(false);
    }, fail);
  };

  const onCancel = async () => {
    setProblem(null);
    try {
      const { customerErasureCancel } = await cancel.mutateAsync({ id: customer.id });
      const error = customerErasureCancel.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      fail(failure);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-semibold">{t('care.privacy')}</h3>
      <p className="text-secondary">{t('care.privacyHint')}</p>
      <Button
        variant="secondary"
        className="self-start"
        busy={exporting.isPending}
        icon={<Download aria-hidden className="size-5" />}
        onClick={onExport}
      >
        {t('care.export')}
      </Button>
      {exported && <Alert tone="success">{t('care.exported', { file: exported })}</Alert>}
      {customer.erasureScheduledAt ? (
        <Alert tone="warning">
          <p>
            {t('care.erasing', {
              date: formatDateTime(customer.erasureScheduledAt, timezone, locale),
            })}
          </p>
          <Button
            variant="secondary"
            className="mt-2"
            busy={cancel.isPending}
            icon={<Undo2 aria-hidden className="size-5" />}
            onClick={() => void onCancel()}
          >
            {t('care.keep')}
          </Button>
        </Alert>
      ) : asking ? (
        <Alert tone="warning">
          <p>{t('care.eraseAsk', { name: customer.displayName })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="destructive" busy={erase.isPending} onClick={onErase}>
              {t('care.eraseSure')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('care.keep')}
            </Button>
          </div>
        </Alert>
      ) : (
        <Button
          variant="danger"
          className="self-start"
          icon={<ShieldX aria-hidden className="size-5" />}
          onClick={() => setAsking(true)}
        >
          {t('care.erase')}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {panel}
    </div>
  );
}

/** Merging their records, and what they may ask of the shop: for owners and managers. */
export function CustomerCare({ customer }: { customer: CustomerDetail }) {
  const { t } = useLocale();
  return (
    <FormSection title={t('care.title')}>
      <Merge customer={customer} />
      <hr className="border-line" />
      <Privacy customer={customer} />
    </FormSection>
  );
}

/** Customers' erasures waiting to happen, the soonest first, each a tap from its customer. */
export function ErasuresPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const query = useAdminQuery<CustomerErasureRequestsData>(
    ['customerErasureRequests'],
    CustomerErasureRequestsQuery,
  );

  const body = () => {
    if (query.isPending) return <Loading label={t('state.loading')} />;
    if (query.isError) {
      return (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      );
    }
    const waiting = query.data.customerErasureRequests.nodes;
    if (waiting.length === 0) return <EmptyState title={t('care.noErasures')} />;
    return (
      <Card>
        <ul className="divide-y divide-line">
          {waiting.map((each) => (
            <li key={each.customer.id}>
              <Link
                to="/$shopId/customers/$customerId"
                params={{ shopId: shop.id, customerId: each.customer.id }}
                className="flex flex-col gap-0.5 px-4 py-3 hover:bg-canvas"
              >
                <span className="flex flex-wrap justify-between gap-x-3">
                  <span className="font-medium" dir="auto">
                    {each.customer.displayName}
                  </span>
                  <span className="num text-secondary" dir="ltr">
                    {shownPhone(each.customer.phone)}
                  </span>
                </span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('care.erasedOn', {
                    date: formatDateTime(each.scheduledAt, timezone, locale),
                    asked: formatDate(each.requestedAt, timezone, locale),
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/customers"
        params={{ shopId: shop.id }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('customers.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('care.erasures')}
      </h1>
      <p className="text-secondary">{t('care.erasuresHint')}</p>
      {body()}
    </div>
  );
}
