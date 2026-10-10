/** Something off for paying ahead, by transfer (ADR-077) or online (ADR-222), as forms hold it. */
import type { MoneyValue, TransferDiscountKind } from '../api/types';
import { useLocale } from '../i18n/locale';
import { priceText } from '../products/product-form';
import { TextField } from '../ui/field';
import { amountInput, Pair, SelectField } from './settings-form';

export type DiscountChoice = 'NONE' | TransferDiscountKind;

export interface PrepaidDiscountState {
  discount: DiscountChoice;
  amount: string;
  percentage: string;
  cap: string;
}

/** The discount as the core says it, to fill the form with. */
export function prepaidDiscountState(
  discount: {
    kind: TransferDiscountKind;
    amount: MoneyValue | null;
    percentage: number | null;
    cap: MoneyValue | null;
  } | null,
): PrepaidDiscountState {
  return {
    discount: discount?.kind ?? 'NONE',
    amount: priceText(discount?.amount?.amount),
    percentage: discount?.percentage?.toString() ?? '',
    cap: priceText(discount?.cap?.amount),
  };
}

/** The discount as the API takes it: an amount, a percentage with a cap or none, or null. */
export function prepaidDiscountInput(state: PrepaidDiscountState) {
  return state.discount === 'NONE'
    ? null
    : state.discount === 'FIXED_AMOUNT'
      ? { amount: state.amount.trim() }
      : {
          percentage: Number(state.percentage.trim().replace(/%$/, '')),
          cap: amountInput(state.cap),
        };
}

/** Whether a percentage chosen is not one the core could take, such as "ten". */
export function badPercentage(state: PrepaidDiscountState): boolean {
  return (
    state.discount === 'PERCENTAGE' &&
    !/^\d{1,2}(\.\d{1,2})?$/.test(state.percentage.trim().replace(/%$/, ''))
  );
}

/** Nothing off, a percentage up to a cap, or an amount: chosen, then what it takes off. */
export function PrepaidDiscountFields({
  label,
  state,
  onChange,
}: {
  label: string;
  state: PrepaidDiscountState;
  onChange: (change: Partial<PrepaidDiscountState>) => void;
}) {
  const { t } = useLocale();
  const choices: { value: DiscountChoice; label: string }[] = [
    { value: 'NONE', label: t('transfer.discount.NONE') },
    { value: 'PERCENTAGE', label: t('transfer.discount.PERCENTAGE') },
    { value: 'FIXED_AMOUNT', label: t('transfer.discount.FIXED_AMOUNT') },
  ];
  return (
    <>
      <SelectField
        label={label}
        value={state.discount}
        options={choices}
        onChange={(discount) => onChange({ discount })}
      />
      {state.discount === 'FIXED_AMOUNT' && (
        <TextField
          label={t('transfer.amount')}
          required
          inputMode="decimal"
          ltr
          value={state.amount}
          onChange={(event) => onChange({ amount: event.target.value })}
        />
      )}
      {state.discount === 'PERCENTAGE' && (
        <Pair>
          <TextField
            label={t('transfer.percentage')}
            hint={t('transfer.percentageHint')}
            required
            inputMode="decimal"
            ltr
            value={state.percentage}
            onChange={(event) => onChange({ percentage: event.target.value })}
          />
          <TextField
            label={t('transfer.cap')}
            hint={t('transfer.capHint')}
            inputMode="decimal"
            ltr
            value={state.cap}
            onChange={(event) => onChange({ cap: event.target.value })}
          />
        </Pair>
      )}
    </>
  );
}
