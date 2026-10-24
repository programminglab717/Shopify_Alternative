import { Pencil, Plus, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  WebhookDeliveriesQuery,
  WebhookSubscriptionCreateMutation,
  WebhookSubscriptionDeleteMutation,
  WebhookSubscriptionUpdateMutation,
} from '../api/operations';
import type {
  CustomApp,
  WebhookDeliveriesData,
  WebhookDelivery,
  WebhookSubscription,
  WebhookSubscriptionCreateData,
  WebhookSubscriptionDeleteData,
  WebhookSubscriptionUpdateData,
  WebhookTopic,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { SelectField } from './settings-form';

/** The topics, each with what an app must read to hear it, as the core names them (ADR-397). */
const TOPICS: readonly { topic: WebhookTopic; reads: string | null }[] = [
  { topic: 'ORDERS_CREATE', reads: 'orders' },
  { topic: 'ORDERS_UPDATED', reads: 'orders' },
  { topic: 'ORDERS_CANCELLED', reads: 'orders' },
  { topic: 'ORDERS_PAID', reads: 'orders' },
  { topic: 'FULFILLMENTS_CREATE', reads: 'orders' },
  { topic: 'FULFILLMENTS_UPDATE', reads: 'orders' },
  { topic: 'PRODUCTS_CREATE', reads: 'products' },
  { topic: 'PRODUCTS_UPDATE', reads: 'products' },
  { topic: 'PRODUCTS_DELETE', reads: 'products' },
  { topic: 'INVENTORY_LEVELS_UPDATE', reads: 'inventory' },
  { topic: 'CUSTOMERS_CREATE', reads: 'customers' },
  { topic: 'CUSTOMERS_UPDATE', reads: 'customers' },
  { topic: 'APP_UNINSTALLED', reads: null },
];

/** The topics an app with `scopes` may hear. */
function topicsFor(scopes: readonly string[]): WebhookTopic[] {
  return TOPICS.filter(
    ({ reads }) =>
      reads === null || scopes.includes(`read_${reads}`) || scopes.includes(`write_${reads}`),
  ).map(({ topic }) => topic);
}

/** How a delivery went, in words. */
function DeliveryWords({ delivery }: { delivery: WebhookDelivery | null }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const when = (iso: string) => formatDateTime(iso, timezone, locale);
  if (!delivery) return <span className="text-secondary">{t('webhooks.nothingYet')}</span>;
  const why = delivery.error ?? (delivery.responseStatus ? `HTTP ${delivery.responseStatus}` : '');
  switch (delivery.status) {
    case 'DELIVERED':
      return (
        <span className="text-success">
          {t('webhooks.delivered', { date: when(delivery.lastAttemptAt ?? delivery.createdAt) })}
        </span>
      );
    case 'FAILED':
      return (
        <span className="text-danger">
          {t('webhooks.failed', {
            date: when(delivery.lastAttemptAt ?? delivery.createdAt),
            why,
          })}
        </span>
      );
    default:
      return (
        <span className="text-warning">
          {delivery.attempts === 0 || !delivery.nextAttemptAt
            ? t('webhooks.waiting')
            : t('webhooks.retrying', { date: when(delivery.nextAttemptAt), why })}
        </span>
      );
  }
}

/** A subscription's recent deliveries, asked for when opened. */
function Deliveries({ subscription }: { subscription: WebhookSubscription }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const query = useAdminQuery<WebhookDeliveriesData>(
    ['webhookDeliveries', subscription.id],
    WebhookDeliveriesQuery,
    { subscriptionId: subscription.id, first: 10 },
  );
  if (query.isPending) return <span className="text-secondary">{t('state.loading')}</span>;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const deliveries = query.data.webhookDeliveries;
  if (deliveries.length === 0) {
    return <span className="text-secondary">{t('webhooks.nothingYet')}</span>;
  }
  return (
    <ul className="flex flex-col gap-1 text-[length:var(--hatti-type-body-sm-size)]">
      {deliveries.map((delivery) => (
        <li key={delivery.id} className="flex flex-wrap gap-x-2">
          <span className="num text-secondary">
            {formatDateTime(delivery.createdAt, timezone, locale)}
          </span>
          <DeliveryWords delivery={delivery} />
          <span className="text-secondary">
            {t('webhooks.tries', { count: delivery.attempts })}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Where a webhook is sent, changed in place (ADR-797), as when an app moves its server: its topic
 * stays, and an address left as it was sends nothing.
 */
function ChangeAddress({
  subscription,
  onDone,
}: {
  subscription: WebhookSubscription;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const update = useAdminMutation<
    WebhookSubscriptionUpdateData,
    { id: string; callbackUrl: string }
  >(WebhookSubscriptionUpdateMutation);
  const [url, setUrl] = useState(subscription.callbackUrl);
  const [problem, setProblem] = useState<string | null>(null);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (url.trim() === subscription.callbackUrl) {
      onDone();
      return;
    }
    try {
      const { webhookSubscriptionUpdate } = await update.mutateAsync({
        id: subscription.id,
        callbackUrl: url.trim(),
      });
      const error = webhookSubscriptionUpdate.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else onDone();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
      <TextField
        label={t('webhooks.newUrl')}
        hint={t('webhooks.urlHint')}
        ltr
        type="url"
        required
        maxLength={2000}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={update.isPending}>
          {t('webhooks.save')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('action.back')}
        </Button>
      </div>
    </form>
  );
}

/**
 * An app's webhooks (DEV-03, ADR-397), on the shop's apps page: each topic it is sent, where, and
 * how its latest delivery went, with its recent ones to open; one added for a topic the app may
 * hear, at an https address, sent elsewhere (ADR-797), or removed.
 */
export function AppWebhooks({
  app,
  subscriptions,
}: {
  app: CustomApp;
  subscriptions: readonly WebhookSubscription[];
}) {
  const { t } = useLocale();
  const topics = topicsFor(app.scopes);
  const create = useAdminMutation<
    WebhookSubscriptionCreateData,
    { topic: WebhookTopic; callbackUrl: string; appId: string }
  >(WebhookSubscriptionCreateMutation);
  const remove = useAdminMutation<WebhookSubscriptionDeleteData, { id: string }>(
    WebhookSubscriptionDeleteMutation,
  );
  const [adding, setAdding] = useState(false);
  const [topic, setTopic] = useState<WebhookTopic>(topics[0]!);
  const [url, setUrl] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const onAdd = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { webhookSubscriptionCreate } = await create.mutateAsync({
        topic,
        callbackUrl: url.trim(),
        appId: app.id,
      });
      const error = webhookSubscriptionCreate.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else {
        setAdding(false);
        setUrl('');
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const onRemove = async (subscription: WebhookSubscription) => {
    setProblem(null);
    try {
      const { webhookSubscriptionDelete } = await remove.mutateAsync({ id: subscription.id });
      const error = webhookSubscriptionDelete.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const topicWords = (each: WebhookTopic) => t(`webhooks.topic.${each}` as MessageKey);
  return (
    <section
      aria-label={t('webhooks.of', { name: app.name })}
      className="flex flex-col gap-2 rounded-control bg-canvas p-3"
    >
      <h3 className="flex items-center gap-2 font-medium">
        <Webhook aria-hidden className="size-5 text-secondary" />
        {t('webhooks.title')}
      </h3>
      {subscriptions.length === 0 && !adding && (
        <p className="text-secondary">{t('webhooks.none')}</p>
      )}
      <ul className="flex flex-col gap-2">
        {subscriptions.map((subscription) => (
          <li key={subscription.id} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{topicWords(subscription.topic)}</span>
              <span className="flex gap-2">
                <Button
                  variant="secondary"
                  icon={<Pencil aria-hidden className="size-5" />}
                  aria-label={t('webhooks.change', { topic: topicWords(subscription.topic) })}
                  onClick={() => setChanging(subscription.id)}
                />
                <Button
                  variant="danger"
                  icon={<Trash2 aria-hidden className="size-5" />}
                  aria-label={t('webhooks.remove', { topic: topicWords(subscription.topic) })}
                  busy={remove.isPending && remove.variables?.id === subscription.id}
                  onClick={() => void onRemove(subscription)}
                />
              </span>
            </span>
            {changing === subscription.id ? (
              <ChangeAddress subscription={subscription} onDone={() => setChanging(null)} />
            ) : (
              <code className="num break-all text-secondary" dir="ltr">
                {subscription.callbackUrl}
              </code>
            )}
            <span className="flex flex-wrap items-center gap-x-3">
              <DeliveryWords delivery={subscription.lastDelivery} />
              {subscription.lastDelivery && (
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  aria-expanded={open === subscription.id}
                  onClick={() => setOpen(open === subscription.id ? null : subscription.id)}
                >
                  {open === subscription.id ? t('webhooks.hide') : t('webhooks.recent')}
                </button>
              )}
            </span>
            {open === subscription.id && <Deliveries subscription={subscription} />}
          </li>
        ))}
      </ul>
      {adding ? (
        <form onSubmit={(event) => void onAdd(event)} className="flex flex-col gap-3">
          <SelectField<WebhookTopic>
            label={t('webhooks.topic')}
            value={topic}
            options={topics.map((each) => ({ value: each, label: topicWords(each) }))}
            onChange={setTopic}
          />
          <TextField
            label={t('webhooks.url')}
            hint={t('webhooks.urlHint')}
            ltr
            type="url"
            required
            maxLength={2000}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={create.isPending}>
              {t('webhooks.add')}
            </Button>
            <Button variant="tertiary" onClick={() => setAdding(false)}>
              {t('action.back')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="secondary"
          className="self-start"
          icon={<Plus aria-hidden className="size-5" />}
          onClick={() => setAdding(true)}
        >
          {t('webhooks.addOne')}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </section>
  );
}
