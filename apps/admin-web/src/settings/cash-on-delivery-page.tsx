import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CashOnDeliverySettingsQuery,
  CashOnDeliverySettingsUpdateMutation,
} from '../api/operations';
import type {
  CashOnDeliveryAdvanceKind,
  CashOnDeliverySettingsData,
  CashOnDeliverySettingsValue,
  SettingsPayloadData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, priceText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import {
  amountInput,
  CheckField,
  Pair,
  parseList,
  parseScore,
  parseWhole,
  percentText,
  Problems,
  SelectField,
  settingProblem,
} from './settings-form';
import { BackToSettings } from './settings-page';

type AdvanceChoice = 'NONE' | CashOnDeliveryAdvanceKind;

interface AdvanceState {
  kind: AdvanceChoice;
  amount: string;
  percentage: string;
  above: string;
  cities: string;
  productTags: string;
  newCustomers: boolean;
  refusedDeliveries: string;
  riskScore: string;
}

interface CodState {
  fee: string;
  maxOrderTotal: string;
  unavailableCities: string;
  unavailableProductTags: string;
  refusedDeliveriesLimit: string;
  verifyFromScore: string;
  riskScoreLimit: string;
  advance: AdvanceState;
}

function stateOf(settings: CashOnDeliverySettingsValue): CodState {
  const advance = settings.advance;
  return {
    fee: Number(settings.fee.amount) === 0 ? '' : priceText(settings.fee.amount),
    maxOrderTotal: priceText(settings.maxOrderTotal?.amount),
    unavailableCities: settings.unavailableCities.join(', '),
    unavailableProductTags: settings.unavailableProductTags.join(', '),
    refusedDeliveriesLimit: settings.refusedDeliveriesLimit?.toString() ?? '',
    verifyFromScore: percentText(settings.verifyFromScore),
    riskScoreLimit: percentText(settings.riskScoreLimit),
    advance: {
      kind: advance?.kind ?? 'NONE',
      amount: priceText(advance?.amount?.amount),
      percentage: advance?.percentage?.toString() ?? '',
      above: priceText(advance?.above?.amount),
      cities: advance?.cities.join(', ') ?? '',
      productTags: advance?.productTags.join(', ') ?? '',
      newCustomers: advance?.newCustomers ?? false,
      refusedDeliveries: advance?.refusedDeliveries?.toString() ?? '',
      riskScore: percentText(advance?.riskScore),
    },
  };
}

const LABELS: Partial<Record<string, MessageKey>> = {
  fee: 'cod.fee',
  maxOrderTotal: 'cod.maxOrderTotal',
  unavailableCities: 'cod.unavailableCities',
  unavailableProductTags: 'cod.unavailableProductTags',
  refusedDeliveriesLimit: 'cod.refusedDeliveriesLimit',
  verifyFromScore: 'cod.verifyFromScore',
  riskScoreLimit: 'cod.riskScoreLimit',
  amount: 'cod.advanceAmount',
  percentage: 'cod.advancePercentage',
  above: 'cod.advanceAbove',
  cities: 'cod.advanceCities',
  productTags: 'cod.advanceProductTags',
  refusedDeliveries: 'cod.advanceRefused',
  riskScore: 'cod.advanceRiskScore',
};

/** "Advance" before a problem with one of its fields. */
function advanceOf(t: Translate) {
  return (field: string[]) => (field.includes('advance') ? t('cod.advance') : null);
}

/** What the form holds, as the API takes it; or the problems with what was typed. */
function inputOf(state: CodState, t: Translate): Record<string, unknown> | string[] {
  const problems: string[] = [];
  const whole = (text: string, label: MessageKey) => {
    const value = parseWhole(text);
    if (Number.isNaN(value)) problems.push(`${t(label)}: ${t('settings.badNumber')}`);
    return value;
  };
  const score = (text: string, label: MessageKey) => {
    const value = parseScore(text);
    if (Number.isNaN(value)) problems.push(`${t(label)}: ${t('settings.badScore')}`);
    return value;
  };
  const { advance } = state;
  const percentage = advance.percentage.trim();
  if (
    advance.kind === 'PERCENTAGE' &&
    !/^\d{1,3}(\.\d{1,2})?$/.test(percentage.replace(/%$/, ''))
  ) {
    problems.push(`${t('cod.advancePercentage')}: ${t('settings.badPercentage')}`);
  }
  const input = {
    fee: amountInput(state.fee),
    maxOrderTotal: amountInput(state.maxOrderTotal),
    unavailableCities: parseList(state.unavailableCities),
    unavailableProductTags: parseList(state.unavailableProductTags),
    refusedDeliveriesLimit: whole(state.refusedDeliveriesLimit, 'cod.refusedDeliveriesLimit'),
    verifyFromScore: score(state.verifyFromScore, 'cod.verifyFromScore'),
    riskScoreLimit: score(state.riskScoreLimit, 'cod.riskScoreLimit'),
    advance:
      advance.kind === 'NONE'
        ? null
        : {
            ...(advance.kind === 'DELIVERY_CHARGE' && { deliveryCharge: true }),
            ...(advance.kind === 'FIXED_AMOUNT' && { amount: advance.amount.trim() }),
            ...(advance.kind === 'PERCENTAGE' && {
              percentage: Number(percentage.replace(/%$/, '')),
            }),
            above: amountInput(advance.above),
            cities: parseList(advance.cities),
            productTags: parseList(advance.productTags),
            newCustomers: advance.newCustomers,
            refusedDeliveries: whole(advance.refusedDeliveries, 'cod.advanceRefused'),
            riskScore: score(advance.riskScore, 'cod.advanceRiskScore'),
          },
  };
  return problems.length > 0 ? problems : input;
}

function AdvanceFields({
  advance,
  hasAccount,
  onChange,
}: {
  advance: AdvanceState;
  hasAccount: boolean;
  onChange: (advance: AdvanceState) => void;
}) {
  const { t } = useLocale();
  const shopId = useShop().id;
  const choices: { value: AdvanceChoice; label: string }[] = [
    { value: 'NONE', label: t('cod.advance.NONE') },
    { value: 'DELIVERY_CHARGE', label: t('cod.advance.DELIVERY_CHARGE') },
    { value: 'FIXED_AMOUNT', label: t('cod.advance.FIXED_AMOUNT') },
    { value: 'PERCENTAGE', label: t('cod.advance.PERCENTAGE') },
  ];
  return (
    <FormSection title={t('cod.advance')} hint={t('cod.advanceHint')}>
      {!hasAccount && (
        <Alert tone="info">
          {t('cod.advanceNeedsAccount')}{' '}
          <Link
            to="/$shopId/settings/bank-transfer"
            params={{ shopId }}
            className="font-medium underline"
          >
            {t('settings.bankTransfer')}
          </Link>
        </Alert>
      )}
      <SelectField
        label={t('cod.advanceKind')}
        value={advance.kind}
        options={choices}
        onChange={(kind) => onChange({ ...advance, kind })}
      />
      {advance.kind === 'FIXED_AMOUNT' && (
        <TextField
          label={t('cod.advanceAmount')}
          required
          inputMode="decimal"
          ltr
          value={advance.amount}
          onChange={(event) => onChange({ ...advance, amount: event.target.value })}
        />
      )}
      {advance.kind === 'PERCENTAGE' && (
        <TextField
          label={t('cod.advancePercentage')}
          hint={t('cod.advancePercentageHint')}
          required
          inputMode="decimal"
          ltr
          value={advance.percentage}
          onChange={(event) => onChange({ ...advance, percentage: event.target.value })}
        />
      )}
      {advance.kind !== 'NONE' && (
        <>
          <p className="font-medium">{t('cod.advanceOnly')}</p>
          <Pair>
            <TextField
              label={t('cod.advanceAbove')}
              hint={t('cod.advanceAboveHint')}
              inputMode="decimal"
              ltr
              value={advance.above}
              onChange={(event) => onChange({ ...advance, above: event.target.value })}
            />
            <TextField
              label={t('cod.advanceRefused')}
              hint={t('cod.advanceRefusedHint')}
              inputMode="numeric"
              ltr
              value={advance.refusedDeliveries}
              onChange={(event) => onChange({ ...advance, refusedDeliveries: event.target.value })}
            />
          </Pair>
          <TextField
            label={t('cod.advanceCities')}
            hint={t('cod.advanceCitiesHint')}
            dir="auto"
            value={advance.cities}
            onChange={(event) => onChange({ ...advance, cities: event.target.value })}
          />
          <TextField
            label={t('cod.advanceProductTags')}
            hint={t('cod.advanceProductTagsHint')}
            dir="auto"
            value={advance.productTags}
            onChange={(event) => onChange({ ...advance, productTags: event.target.value })}
          />
          <TextField
            label={t('cod.advanceRiskScore')}
            hint={t('cod.advanceRiskScoreHint')}
            inputMode="numeric"
            ltr
            value={advance.riskScore}
            onChange={(event) => onChange({ ...advance, riskScore: event.target.value })}
          />
          <CheckField
            label={t('cod.advanceNewCustomers')}
            hint={t('cod.advanceNewCustomersHint')}
            checked={advance.newCustomers}
            onChange={(newCustomers) => onChange({ ...advance, newCustomers })}
          />
        </>
      )}
    </FormSection>
  );
}

function CashOnDeliveryForm({ data }: { data: CashOnDeliverySettingsData }) {
  const { t } = useLocale();
  const save = useAdminMutation<
    { cashOnDeliverySettingsUpdate: SettingsPayloadData },
    { input: Record<string, unknown> }
  >(CashOnDeliverySettingsUpdateMutation);
  const [state, setState] = useState(() => stateOf(data.cashOnDeliverySettings));
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const set = (change: Partial<CodState>) => setState({ ...state, ...change });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const input = inputOf(state, t);
    if (Array.isArray(input)) {
      setProblems(input);
      return;
    }
    setProblems([]);
    try {
      const { cashOnDeliverySettingsUpdate } = await save.mutateAsync({ input });
      if (cashOnDeliverySettingsUpdate.userErrors.length > 0) {
        setProblems(
          cashOnDeliverySettingsUpdate.userErrors.map((error) =>
            settingProblem(error, t, LABELS, advanceOf(t)),
          ),
        );
      } else setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('cod.charges')}>
        <Pair>
          <TextField
            label={t('cod.fee')}
            hint={t('cod.feeHint')}
            inputMode="decimal"
            ltr
            value={state.fee}
            onChange={(event) => set({ fee: event.target.value })}
          />
          <TextField
            label={t('cod.maxOrderTotal')}
            hint={t('cod.maxOrderTotalHint')}
            inputMode="decimal"
            ltr
            value={state.maxOrderTotal}
            onChange={(event) => set({ maxOrderTotal: event.target.value })}
          />
        </Pair>
      </FormSection>
      <FormSection title={t('cod.where')} hint={t('cod.whereHint')}>
        <TextField
          label={t('cod.unavailableCities')}
          hint={t('cod.unavailableCitiesHint')}
          dir="auto"
          value={state.unavailableCities}
          onChange={(event) => set({ unavailableCities: event.target.value })}
        />
        <TextField
          label={t('cod.unavailableProductTags')}
          hint={t('cod.unavailableProductTagsHint')}
          dir="auto"
          value={state.unavailableProductTags}
          onChange={(event) => set({ unavailableProductTags: event.target.value })}
        />
      </FormSection>
      <FormSection title={t('cod.risk')} hint={t('cod.riskHint')}>
        <TextField
          label={t('cod.refusedDeliveriesLimit')}
          hint={t('cod.refusedDeliveriesLimitHint')}
          inputMode="numeric"
          ltr
          value={state.refusedDeliveriesLimit}
          onChange={(event) => set({ refusedDeliveriesLimit: event.target.value })}
        />
        <Pair>
          <TextField
            label={t('cod.verifyFromScore')}
            hint={t('cod.verifyFromScoreHint')}
            inputMode="numeric"
            ltr
            value={state.verifyFromScore}
            onChange={(event) => set({ verifyFromScore: event.target.value })}
          />
          <TextField
            label={t('cod.riskScoreLimit')}
            hint={t('cod.riskScoreLimitHint')}
            inputMode="numeric"
            ltr
            value={state.riskScoreLimit}
            onChange={(event) => set({ riskScoreLimit: event.target.value })}
          />
        </Pair>
      </FormSection>
      <AdvanceFields
        advance={state.advance}
        hasAccount={data.bankTransferSettings.account !== null}
        onChange={(advance) => set({ advance })}
      />
      <Problems problems={problems} />
      {saved && <Alert tone="success">{t('settings.saved')}</Alert>}
      <Button type="submit" busy={save.isPending} className="self-start">
        {t('product.save')}
      </Button>
    </form>
  );
}

/**
 * Cash on delivery's rules at checkout (CHK-07, ADR-075 to ADR-099): its fee, the most it
 * collects, where and for whom checkout offers bank transfer instead, when it asks a code first
 * (CHK-09), and the advance it may ask (CHK-10). Orders staff place keep to the law's cap alone.
 */
export function CashOnDeliveryPage() {
  const { t } = useLocale();
  const query = useAdminQuery<CashOnDeliverySettingsData>(
    ['cashOnDeliverySettings'],
    CashOnDeliverySettingsQuery,
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.cashOnDelivery')}
      </h1>
      <CashOnDeliveryForm data={query.data} />
    </div>
  );
}
