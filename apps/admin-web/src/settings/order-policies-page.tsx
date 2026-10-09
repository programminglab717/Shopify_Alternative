import { ListChecks, Save } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  OrderPoliciesQuery,
  OrderRiskSettingsUpdateMutation,
  OrderSettingsUpdateMutation,
} from '../api/operations';
import type {
  CustomerCancellation,
  OrderPoliciesData,
  OrderRiskSettings,
  OrderRiskSettingsUpdateData,
  OrderSettings,
  OrderSettingsUpdateData,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, priceText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import {
  amountInput,
  CheckField,
  Pair,
  parseScore,
  parseWhole,
  percentText,
  Problems,
  settingProblem,
} from './settings-form';
import { BackToSettings } from './settings-page';

const CANCELLATIONS: readonly CustomerCancellation[] = ['UNTIL_PACKED', 'UNTIL_CONFIRMED'];

const LABELS: Partial<Record<string, MessageKey>> = {
  callingHours: 'orderPolicies.callingHours',
  opens: 'orderPolicies.opens',
  closes: 'orderPolicies.closes',
  firstCallMinutes: 'orderPolicies.firstCall',
  cancelUnpaidAfterDays: 'orderPolicies.unpaidDays',
  cancelUnreachableAfterDays: 'orderPolicies.unreachableDays',
  highValue: 'orderPolicies.highValue',
  holdAt: 'orderPolicies.holdAt',
};

/** A number of whole units as typed, or blank for none; what is not one stays NaN. */
const wholeOrNone = (text: string) => parseWhole(text);

/** The order settings as the core would keep them from what the form holds. */
function orderInputOf(state: {
  anyTime: boolean;
  opens: string;
  closes: string;
  firstCall: string;
  waits: boolean;
  unpaid: string;
  unreachable: string;
  cancellation: CustomerCancellation;
}) {
  return {
    callingHours: state.anyTime ? null : { opens: state.opens, closes: state.closes },
    firstCallMinutes: wholeOrNone(state.firstCall),
    deskWaitsForReminder: state.waits,
    cancelUnpaidAfterDays: wholeOrNone(state.unpaid),
    cancelUnreachableAfterDays: wholeOrNone(state.unreachable),
    customerCancellation: state.cancellation,
  };
}

function stateOf(settings: OrderSettings) {
  return {
    anyTime: settings.callingHours === null,
    opens: settings.callingHours?.opens ?? '10:00',
    closes: settings.callingHours?.closes ?? '21:00',
    firstCall: settings.firstCallMinutes === null ? '' : String(settings.firstCallMinutes),
    waits: settings.deskWaitsForReminder,
    unpaid: settings.cancelUnpaidAfterDays === null ? '' : String(settings.cancelUnpaidAfterDays),
    unreachable:
      settings.cancelUnreachableAfterDays === null
        ? ''
        : String(settings.cancelUnreachableAfterDays),
    cancellation: settings.customerCancellation,
  };
}

/** What differs between two inputs, by field. */
function changesOf<T extends Record<string, unknown>>(now: T, was: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(now).filter(([key, value]) =>
      value !== null && typeof value === 'object'
        ? JSON.stringify(value) !== JSON.stringify(was[key])
        : !Object.is(value, was[key]),
    ),
  ) as Partial<T>;
}

function PoliciesForm({ settings, risk }: { settings: OrderSettings; risk: OrderRiskSettings }) {
  const { t } = useLocale();
  const name = useId();
  const updateOrders = useAdminMutation<
    OrderSettingsUpdateData,
    { input: Record<string, unknown> }
  >(OrderSettingsUpdateMutation);
  const updateRisk = useAdminMutation<
    OrderRiskSettingsUpdateData,
    { input: Record<string, unknown> }
  >(OrderRiskSettingsUpdateMutation);
  const [state, setState] = useState(() => stateOf(settings));
  const [highValue, setHighValue] = useState(priceText(risk.highValue.amount));
  const [holdAt, setHoldAt] = useState(percentText(risk.holdAt));
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const set = (change: Partial<typeof state>) => setState((all) => ({ ...all, ...change }));

  const orderChanges = changesOf(orderInputOf(state), orderInputOf(stateOf(settings)));
  const riskNow = { highValue: amountInput(highValue), holdAt: parseScore(holdAt) };
  const riskChanges = changesOf(riskNow, {
    highValue: amountInput(priceText(risk.highValue.amount)),
    holdAt: risk.holdAt,
  });
  const changed = Object.keys(orderChanges).length + Object.keys(riskChanges).length > 0;

  const named = (errors: UserError[]) =>
    errors.map((error) => settingProblem(error, t, LABELS, () => null));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    const bad = [
      ...Object.entries(orderChanges)
        .filter(([, value]) => typeof value === 'number' && Number.isNaN(value))
        .map(([key]) => key),
      ...(Number.isNaN(riskNow.holdAt) ? ['holdAt'] : []),
    ];
    if (bad.length > 0) {
      setProblems(bad.map((key) => `${t(LABELS[key]!)}: ${t('orderPolicies.notWhole')}`));
      return;
    }
    if (riskChanges.highValue === null) {
      setProblems([`${t('orderPolicies.highValue')}: ${t('orderPolicies.needsAmount')}`]);
      return;
    }
    setProblems([]);
    setSaved(false);
    try {
      if (Object.keys(orderChanges).length > 0) {
        const { orderSettingsUpdate } = await updateOrders.mutateAsync({ input: orderChanges });
        if (orderSettingsUpdate.userErrors.length > 0 || !orderSettingsUpdate.orderSettings) {
          setProblems(named(orderSettingsUpdate.userErrors));
          return;
        }
      }
      if (Object.keys(riskChanges).length > 0) {
        const { orderRiskSettingsUpdate } = await updateRisk.mutateAsync({ input: riskChanges });
        const kept = orderRiskSettingsUpdate.riskSettings;
        if (orderRiskSettingsUpdate.userErrors.length > 0 || !kept) {
          setProblems(named(orderRiskSettingsUpdate.userErrors));
          return;
        }
        setHighValue(priceText(kept.highValue.amount));
      }
      setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('orderPolicies.desk')} hint={t('orderPolicies.deskHint')}>
        <CheckField
          label={t('orderPolicies.anyTime')}
          hint={t('orderPolicies.anyTimeHint')}
          checked={state.anyTime}
          onChange={(anyTime) => set({ anyTime })}
        />
        {!state.anyTime && (
          <Pair>
            <TextField
              label={t('orderPolicies.opens')}
              type="time"
              ltr
              value={state.opens}
              onChange={(event) => set({ opens: event.target.value })}
            />
            <TextField
              label={t('orderPolicies.closes')}
              type="time"
              ltr
              value={state.closes}
              onChange={(event) => set({ closes: event.target.value })}
            />
          </Pair>
        )}
        <TextField
          label={t('orderPolicies.firstCall')}
          hint={t('orderPolicies.firstCallHint')}
          inputMode="numeric"
          ltr
          value={state.firstCall}
          onChange={(event) => set({ firstCall: event.target.value })}
        />
        <CheckField
          label={t('orderPolicies.waits')}
          hint={t('orderPolicies.waitsHint')}
          checked={state.waits}
          onChange={(waits) => set({ waits })}
        />
      </FormSection>

      <FormSection title={t('orderPolicies.cancelling')} hint={t('orderPolicies.cancellingHint')}>
        <Pair>
          <TextField
            label={t('orderPolicies.unpaidDays')}
            hint={t('orderPolicies.unpaidDaysHint')}
            inputMode="numeric"
            ltr
            value={state.unpaid}
            onChange={(event) => set({ unpaid: event.target.value })}
          />
          <TextField
            label={t('orderPolicies.unreachableDays')}
            hint={t('orderPolicies.unreachableDaysHint')}
            inputMode="numeric"
            ltr
            value={state.unreachable}
            onChange={(event) => set({ unreachable: event.target.value })}
          />
        </Pair>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">{t('orderPolicies.customerCancels')}</legend>
          {CANCELLATIONS.map((each) => (
            <label
              key={each}
              className={`flex cursor-pointer items-start gap-3 rounded-control border p-3 ${
                state.cancellation === each ? 'border-primary' : 'border-line'
              }`}
            >
              <input
                type="radio"
                name={name}
                value={each}
                checked={state.cancellation === each}
                onChange={() => set({ cancellation: each })}
                className="mt-1 size-5 accent-[var(--hatti-color-primary)]"
              />
              <span className="flex flex-col">
                <span className="font-medium">
                  {t(`orderPolicies.cancel.${each}` as MessageKey)}
                </span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t(`orderPolicies.cancelHint.${each}` as MessageKey)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      </FormSection>

      <FormSection title={t('orderPolicies.risk')} hint={t('orderPolicies.riskHint')}>
        <Pair>
          <TextField
            label={t('orderPolicies.highValue')}
            hint={t('orderPolicies.highValueHint', {
              amount: formatMoney(risk.highValue.amount, risk.highValue.currencyCode),
            })}
            inputMode="decimal"
            ltr
            value={highValue}
            onChange={(event) => setHighValue(event.target.value)}
          />
          <TextField
            label={t('orderPolicies.holdAt')}
            hint={t('orderPolicies.holdAtHint')}
            inputMode="numeric"
            ltr
            value={holdAt}
            onChange={(event) => setHoldAt(event.target.value)}
          />
        </Pair>
      </FormSection>

      <Problems problems={problems} />
      {saved && !changed && <Alert tone="success">{t('orderPolicies.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={updateOrders.isPending || updateRisk.isPending}
        disabled={!changed}
        icon={<Save aria-hidden className="size-5" />}
      >
        {t('orderPolicies.save')}
      </Button>
    </form>
  );
}

/**
 * The shop's order policies (COD-05, COD-06, ORD-01, ADR-168): when the Confirmation Desk calls,
 * how soon the first call should come and whether it waits for WhatsApp's answer; when orders
 * left unpaid or with a customer who cannot be reached are cancelled; until when customers may
 * cancel; and which cash-on-delivery orders count as high value and wait for review.
 */
export function OrderPoliciesPage() {
  const { t } = useLocale();
  const query = useAdminQuery<OrderPoliciesData>(['orderPolicies'], OrderPoliciesQuery);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <ListChecks aria-hidden className="size-7 text-secondary" />
        {t('orderPolicies.title')}
      </h1>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <PoliciesForm settings={query.data.orderSettings} risk={query.data.orderRiskSettings} />
      )}
    </div>
  );
}
