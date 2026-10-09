import { Link } from '@tanstack/react-router';
import { MessageSquareText, Save } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  MessagesQuery,
  MessagingSettingsQuery,
  MessagingSettingsUpdateMutation,
} from '../api/operations';
import type {
  MessageLanguage,
  MessageRouting,
  MessageStatus,
  MessagesData,
  MessagingSettings,
  MessagingSettingsData,
  MessagingSettingsUpdateData,
  SentMessage,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime, formatMoney, formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CheckField, Problems, SelectField, settingProblem } from './settings-form';
import { BackToSettings } from './settings-page';

/** What the shop's customers hear of their orders, which it may turn off (MSG-01). */
const TO_CUSTOMERS = [
  'ORDER_CONFIRMATION',
  'ORDER_CONFIRMATION_REMINDER',
  'ORDER_PLACED',
  'ORDER_CONFIRMED',
  'ORDER_PAYMENT_REMINDER',
  'ORDER_PAID',
  'ORDER_ADVANCE_PAID',
  'ORDER_SHIPPED',
  'ORDER_OUT_FOR_DELIVERY',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
  'ORDER_ADDRESS',
  'STORE_CREDIT_GIVEN',
  'STORE_CREDIT_EXPIRING',
] as const;

/** What the shop and its staff hear, which it may turn off too. */
const TO_THE_SHOP = [
  'ORDER_ASSIGNED',
  'ORDER_MENTIONED',
  'ORDER_RECEIPT_SENT',
  'STOCK_LOW',
  'STOCK_OUT',
] as const;

const ROUTINGS: readonly MessageRouting[] = ['RICH', 'ECONOMY'];

/** The messages listed: all of them, or those of one status. */
const STATUSES = ['ALL', 'PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED'] as const;
type StatusChoice = (typeof STATUSES)[number];

const LABELS: Partial<Record<string, MessageKey>> = {
  alertsPhone: 'messages.alertsPhone',
  disabledNotifications: 'messages.which',
};

/** What is always sent, which the shop cannot turn off: codes at checkout, and Hatti's notices. */
const ALWAYS_SENT = [
  'ONE_TIME_CODE',
  'INVOICE_DUE',
  'PLAN_ENDED',
  'CREDIT_LOW',
  'TRANSFER_CONFIRMED',
  'TRANSFER_REFUSED',
  'DOMAIN_UNPOINTED',
  'ORDERS_LIMIT_NEAR',
  'ORDERS_LIMIT_REACHED',
] as const;

const KNOWN: ReadonlySet<string> = new Set([...TO_CUSTOMERS, ...TO_THE_SHOP, ...ALWAYS_SENT]);

/** A message's kind in the merchant's words; one newer than the admin, by its own name. */
function kindLabel(kind: string, t: (key: MessageKey) => string): string {
  return KNOWN.has(kind)
    ? t(`messages.kind.${kind}` as MessageKey)
    : kind.toLowerCase().replaceAll('_', ' ');
}

/** The settings as the core would keep them from what the form holds. */
function inputOf(
  routing: MessageRouting,
  language: MessageLanguage,
  disabled: readonly string[],
  phone: string,
) {
  return {
    routing,
    language,
    disabledNotifications: [...disabled].sort(),
    alertsPhone: phone.trim() || null,
  };
}

function SettingsForm({
  settings,
  prices,
}: {
  settings: MessagingSettings;
  prices: MessagingSettingsData['billingMessagePrices'];
}) {
  const { t } = useLocale();
  const name = useId();
  const update = useAdminMutation<MessagingSettingsUpdateData, { input: Record<string, unknown> }>(
    MessagingSettingsUpdateMutation,
  );
  const [routing, setRouting] = useState(settings.routing);
  const [language, setLanguage] = useState(settings.language);
  const [disabled, setDisabled] = useState<string[]>(settings.disabledNotifications);
  const [phone, setPhone] = useState(settings.alertsPhone ? formatPhone(settings.alertsPhone) : '');
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const now = inputOf(routing, language, disabled, phone);
  const was = inputOf(
    settings.routing,
    settings.language,
    settings.disabledNotifications,
    settings.alertsPhone ? formatPhone(settings.alertsPhone) : '',
  );
  const changes = Object.fromEntries(
    Object.entries(now).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(was[key as keyof typeof was]),
    ),
  );
  const changed = Object.keys(changes).length > 0;
  const price = (channel: 'WHATSAPP' | 'SMS') => {
    const found = prices.find((each) => each.channel === channel && each.category === 'UTILITY');
    return found ? formatMoney(found.price.amount) : '';
  };

  const toggle = (kind: string, on: boolean) =>
    setDisabled((all) => (on ? all.filter((each) => each !== kind) : [...all, kind]));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setProblems([]);
    setSaved(false);
    try {
      const { messagingSettingsUpdate } = await update.mutateAsync({ input: changes });
      const kept = messagingSettingsUpdate.messagingSettings;
      if (messagingSettingsUpdate.userErrors.length > 0 || !kept) {
        setProblems(
          messagingSettingsUpdate.userErrors.map((error) =>
            settingProblem(error, t, LABELS, () => null),
          ),
        );
        return;
      }
      setPhone(kept.alertsPhone ? formatPhone(kept.alertsPhone) : '');
      setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const checks = (kinds: readonly string[]) =>
    kinds.map((kind) => (
      <CheckField
        key={kind}
        label={kindLabel(kind, t)}
        hint={t(`messages.hint.${kind}` as MessageKey)}
        checked={!disabled.includes(kind)}
        onChange={(on) => toggle(kind, on)}
      />
    ));

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('messages.how')} hint={t('messages.howHint')}>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{t('messages.how')}</legend>
          {ROUTINGS.map((each) => (
            <label
              key={each}
              className={`flex cursor-pointer items-start gap-3 rounded-control border p-3 ${
                routing === each ? 'border-primary' : 'border-line'
              }`}
            >
              <input
                type="radio"
                name={name}
                value={each}
                checked={routing === each}
                onChange={() => setRouting(each)}
                className="mt-1 size-5 accent-[var(--hatti-color-primary)]"
              />
              <span className="flex flex-col">
                <span className="font-medium">{t(`messages.routing.${each}` as MessageKey)}</span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t(`messages.routingHint.${each}` as MessageKey, {
                    whatsapp: price('WHATSAPP'),
                    sms: price('SMS'),
                  })}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <SelectField<MessageLanguage>
          label={t('messages.language')}
          value={language}
          options={[
            { value: 'UR', label: t('messages.language.UR') },
            { value: 'EN', label: t('messages.language.EN') },
          ]}
          onChange={setLanguage}
        />
      </FormSection>

      <FormSection title={t('messages.toCustomers')} hint={t('messages.toCustomersHint')}>
        {checks(TO_CUSTOMERS)}
      </FormSection>

      <FormSection title={t('messages.toShop')} hint={t('messages.toShopHint')}>
        <TextField
          label={t('messages.alertsPhone')}
          hint={t('messages.alertsPhoneHint')}
          type="tel"
          inputMode="tel"
          placeholder="0300 1234567"
          autoComplete="off"
          ltr
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
        {checks(TO_THE_SHOP)}
      </FormSection>

      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('messages.always')}
      </p>
      <Problems problems={problems} />
      {saved && !changed && <Alert tone="success">{t('messages.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={update.isPending}
        disabled={!changed}
        icon={<Save aria-hidden className="size-5" />}
      >
        {t('messages.save')}
      </Button>
    </form>
  );
}

/** One message, how it went, and its order. */
function MessageRow({
  message,
  timezone,
  withOrder,
}: {
  message: SentMessage;
  timezone: string;
  withOrder: boolean;
}) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const tone =
    message.status === 'FAILED'
      ? 'text-danger'
      : message.status === 'DELIVERED' || message.status === 'READ'
        ? 'text-success'
        : 'text-secondary';
  const at =
    message.readAt ?? message.deliveredAt ?? message.sentAt ?? (message.createdAt as string);
  return (
    <li className="flex flex-col gap-0.5 px-4 py-3">
      <span className="flex flex-wrap justify-between gap-x-3">
        <span className="font-medium">{kindLabel(message.kind, t)}</span>
        <span className={`font-medium ${tone}`}>
          {t(`messages.status.${message.status}` as MessageKey)}
        </span>
      </span>
      <span className="flex flex-wrap gap-x-3 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        <span>{t(`messages.channel.${message.channel}` as MessageKey)}</span>
        <span className="num" dir="ltr">
          {message.recipient}
        </span>
        <span>{formatDateTime(at, timezone, locale)}</span>
        {message.attempts > 1 && <span>{t('messages.attempts', { count: message.attempts })}</span>}
        {withOrder && message.orderId && (
          <Link
            to="/$shopId/orders/$orderId"
            params={{ shopId: shop.id, orderId: message.orderId }}
            className="font-medium text-primary underline"
          >
            {t('messages.order')}
          </Link>
        )}
      </span>
      {message.error && (
        <span dir="auto" className="text-danger text-[length:var(--hatti-type-body-sm-size)]">
          {message.error}
        </span>
      )}
    </li>
  );
}

/** The latest messages, of one order or of them all, by status; or none, to tap for. */
function MessagesList({ orderId, status }: { orderId?: string; status: StatusChoice }) {
  const { t } = useLocale();
  const timezone = useShopTimezone();
  const query = useAdminQuery<MessagesData>(['messages', orderId ?? null, status], MessagesQuery, {
    orderId: orderId ?? null,
    status: status === 'ALL' ? null : (status as MessageStatus),
  });
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { nodes, pageInfo } = query.data.messages;
  if (nodes.length === 0) {
    return (
      <p className="text-secondary">{t(orderId ? 'messages.noneForOrder' : 'messages.none')}</p>
    );
  }
  return (
    <>
      <Card>
        <ul className="divide-y divide-line">
          {nodes.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              timezone={timezone}
              withOrder={!orderId}
            />
          ))}
        </ul>
      </Card>
      {pageInfo.hasNextPage && (
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('messages.latestOnly')}
        </p>
      )}
    </>
  );
}

/** The latest messages about the shop's orders, and how sending each went, by status. */
function SentMessages() {
  const { t } = useLocale();
  const [status, setStatus] = useState<StatusChoice>('ALL');
  return (
    <section aria-labelledby="messages-sent" className="flex flex-col gap-3">
      <h2 id="messages-sent" className="font-semibold">
        {t('messages.sent')}
      </h2>
      <SelectField<StatusChoice>
        label={t('messages.showing')}
        value={status}
        options={STATUSES.map((each) => ({
          value: each,
          label: t(`messages.filter.${each}` as MessageKey),
        }))}
        onChange={setStatus}
      />
      <MessagesList status={status} />
    </section>
  );
}

/** An order's messages, asked for when staff tap to see them: what its customer was told. */
export function OrderMessages({ orderId }: { orderId: string }) {
  const { t } = useLocale();
  const [shown, setShown] = useState(false);
  return shown ? (
    <div className="flex flex-col gap-2">
      <MessagesList orderId={orderId} status="ALL" />
    </div>
  ) : (
    <Button
      variant="secondary"
      className="self-start"
      icon={<MessageSquareText aria-hidden className="size-5" />}
      onClick={() => setShown(true)}
    >
      {t('messages.showForOrder')}
    </Button>
  );
}

/**
 * Customer messages (MSG-01, MSG-03, ADR-146): how the shop's customers hear of their orders, on
 * WhatsApp for everything or by SMS for the updates that need no answer, in which language; which
 * messages it turns off, to customers and to the shop; where Hatti's alerts to the shop go; and
 * the messages sent, with how each went.
 */
export function MessagesPage() {
  const { t } = useLocale();
  const query = useAdminQuery<MessagingSettingsData>(['messagingSettings'], MessagingSettingsQuery);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <MessageSquareText aria-hidden className="size-7 text-secondary" />
        {t('messages.title')}
      </h1>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <SettingsForm
          settings={query.data.messagingSettings}
          prices={query.data.billingMessagePrices}
        />
      )}
      <SentMessages />
    </div>
  );
}
