import { Link } from '@tanstack/react-router';
import { Repeat, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  OrderSubscriptionChangeMutation,
  SellingPlanCreateMutation,
  SellingPlanDeleteMutation,
  SubscriptionsQuery,
} from '../api/operations';
import type {
  OrderSubscription,
  OrderSubscriptionChangeData,
  SellingPlan,
  SellingPlanPayloadData,
  SubscriptionsData,
  UserError,
} from '../api/types';
import { can } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToSettings } from './settings-page';
import { SelectField } from './settings-form';

type Change = 'SKIP' | 'PAUSE' | 'RESUME' | 'CANCEL';

/**
 * Subscriptions (CAT-16, ADR-862): the shop's selling plans, "Every month, 10% off", for its
 * products of a tag or all of them, which its product pages offer; and its customers'
 * subscriptions, each an order placed again each interval by cash on delivery, to skip, pause,
 * resume or cancel for them.
 */
export function SubscriptionsPage() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<SubscriptionsData>(['subscriptions'], SubscriptionsQuery);
  const create = useAdminMutation<SellingPlanPayloadData, { input: Omit<SellingPlan, 'id'> }>(
    SellingPlanCreateMutation,
  );
  const remove = useAdminMutation<SellingPlanPayloadData, { id: string }>(
    SellingPlanDeleteMutation,
  );
  const change = useAdminMutation<OrderSubscriptionChangeData, { id: string; change: Change }>(
    OrderSubscriptionChangeMutation,
  );
  const [name, setName] = useState('Every month');
  const [unit, setUnit] = useState<'WEEK' | 'MONTH'>('MONTH');
  const [count, setCount] = useState('1');
  const [discount, setDiscount] = useState('10');
  const [tag, setTag] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writes = can(shop, 'write_products');
  const changes = can(shop, 'write_orders');

  const show = (errors: UserError[]) => {
    if (errors[0]) setProblem(problemText(errors[0], t));
    return errors.length === 0;
  };
  const run = async (work: () => Promise<void>) => {
    setProblem(null);
    try {
      await work();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    await run(async () => {
      const done = await create.mutateAsync({
        input: {
          name,
          intervalUnit: unit,
          intervalCount: Number(count),
          discountPercent: Number(discount),
          productTag: tag.trim() || null,
        },
      });
      if (show(done.sellingPlanCreate!.userErrors)) setTag('');
    });
    setBusy(false);
  };

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
    const { sellingPlans, orderSubscriptions } = query.data;
    return (
      <>
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="font-semibold">{t('subscriptions.plans')}</h2>
          {sellingPlans.length === 0 ? (
            <p className="text-secondary">{t('subscriptions.noPlans')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {sellingPlans.map((plan) => (
                <li
                  key={plan.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="flex flex-col">
                    <span className="font-medium" dir="auto">
                      {t('subscriptions.planLine', {
                        name: plan.name,
                        percent: plan.discountPercent,
                      })}
                    </span>
                    <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                      {plan.productTag
                        ? t('subscriptions.forTag', { tag: plan.productTag })
                        : t('subscriptions.forAll')}
                    </span>
                  </span>
                  {writes && (
                    <Button
                      variant="danger"
                      icon={<Trash2 aria-hidden className="size-5" />}
                      aria-label={t('subscriptions.deletePlan', { name: plan.name })}
                      onClick={() =>
                        void run(async () => {
                          show(
                            (await remove.mutateAsync({ id: plan.id })).sellingPlanDelete!
                              .userErrors,
                          );
                        })
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {writes && (
            <form onSubmit={(event) => void onCreate(event)} className="flex flex-col gap-3">
              <TextField
                label={t('subscriptions.planName')}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label={t('subscriptions.every')}
                  inputMode="numeric"
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                />
                <SelectField
                  label={t('subscriptions.unit')}
                  value={unit}
                  options={[
                    { value: 'WEEK', label: t('subscriptions.weeks') },
                    { value: 'MONTH', label: t('subscriptions.months') },
                  ]}
                  onChange={setUnit}
                />
              </div>
              <TextField
                label={t('subscriptions.discount')}
                inputMode="numeric"
                value={discount}
                onChange={(event) => setDiscount(event.target.value)}
              />
              <TextField
                label={t('subscriptions.tag')}
                hint={t('subscriptions.tagHint')}
                value={tag}
                onChange={(event) => setTag(event.target.value)}
              />
              <Button type="submit" className="self-start" busy={busy}>
                {t('subscriptions.addPlan')}
              </Button>
            </form>
          )}
        </Card>
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="font-semibold">{t('subscriptions.customers')}</h2>
          {orderSubscriptions.length === 0 ? (
            <p className="text-secondary">{t('subscriptions.none')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {orderSubscriptions.map((subscription) => (
                <SubscriptionRow
                  key={subscription.id}
                  subscription={subscription}
                  changes={changes}
                  onChange={(next) =>
                    void run(async () => {
                      show(
                        (await change.mutateAsync({ id: subscription.id, change: next }))
                          .orderSubscriptionChange.userErrors,
                      );
                    })
                  }
                />
              ))}
            </ul>
          )}
        </Card>
      </>
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Repeat aria-hidden className="size-7 text-secondary" />
        {t('settings.subscriptions')}
      </h1>
      <p className="text-secondary">{t('subscriptions.hint')}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {body()}
    </div>
  );
}

function SubscriptionRow({
  subscription,
  changes,
  onChange,
}: {
  subscription: OrderSubscription;
  changes: boolean;
  onChange: (change: Change) => void;
}) {
  const { t } = useLocale();
  const shop = useShop();
  const who = subscription.name ?? t('subscriptions.erased');
  return (
    <li className="flex flex-col gap-2 py-3">
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium" dir="auto">
          {subscription.city ? `${who}, ${subscription.city}` : who}
        </span>
        <span className="text-secondary">
          {t(`subscriptions.status.${subscription.status}` as MessageKey)}
        </span>
      </span>
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('subscriptions.summary', {
          plan: subscription.planName,
          percent: subscription.discountPercent,
          orders: subscription.ordersPlaced,
        })}
        {subscription.status === 'ACTIVE' &&
          ` · ${t('subscriptions.next', { date: subscription.nextOrderOn })}`}
      </span>
      {subscription.lastError && (
        <Alert tone="warning">
          {t('subscriptions.lastError', { error: subscription.lastError })}
        </Alert>
      )}
      <span className="flex flex-wrap gap-2">
        {subscription.lastOrderId && (
          <Link
            to="/$shopId/orders/$orderId"
            params={{ shopId: shop.id, orderId: subscription.lastOrderId }}
            className="self-center text-text underline"
          >
            {t('subscriptions.lastOrder')}
          </Link>
        )}
        {changes && subscription.status === 'ACTIVE' && (
          <>
            <Button variant="secondary" onClick={() => onChange('SKIP')}>
              {t('subscriptions.skip')}
            </Button>
            <Button variant="secondary" onClick={() => onChange('PAUSE')}>
              {t('subscriptions.pause')}
            </Button>
          </>
        )}
        {changes && subscription.status === 'PAUSED' && (
          <Button variant="secondary" onClick={() => onChange('RESUME')}>
            {t('subscriptions.resume')}
          </Button>
        )}
        {changes && subscription.status !== 'CANCELLED' && (
          <Button variant="danger" onClick={() => onChange('CANCEL')}>
            {t('subscriptions.cancel')}
          </Button>
        )}
      </span>
    </li>
  );
}
