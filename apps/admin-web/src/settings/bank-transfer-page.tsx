import { useState } from 'react';
import type { FormEvent } from 'react';
import { BankTransferSettingsQuery, BankTransferSettingsUpdateMutation } from '../api/operations';
import type {
  BankTransferSettingsData,
  BankTransferSettingsValue,
  SettingsPayloadData,
  TransferDiscountKind,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, priceText, TextArea } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import {
  amountInput,
  CheckField,
  Pair,
  Problems,
  SelectField,
  settingProblem,
} from './settings-form';
import { BackToSettings } from './settings-page';

type DiscountChoice = 'NONE' | TransferDiscountKind;

interface TransferState {
  enabled: boolean;
  bankName: string;
  title: string;
  iban: string;
  raastId: string;
  instructions: string;
  discount: DiscountChoice;
  amount: string;
  percentage: string;
  cap: string;
}

function stateOf(settings: BankTransferSettingsValue): TransferState {
  const { account, discount } = settings;
  return {
    enabled: settings.enabled,
    bankName: account?.bankName ?? '',
    title: account?.title ?? '',
    // Spaced in fours, as banking apps and cheques show an IBAN.
    iban: account?.iban.replace(/(.{4})(?=.)/g, '$1 ') ?? '',
    raastId: account?.raastId ?? '',
    instructions: account?.instructions ?? '',
    discount: discount?.kind ?? 'NONE',
    amount: priceText(discount?.amount?.amount),
    percentage: discount?.percentage?.toString() ?? '',
    cap: priceText(discount?.cap?.amount),
  };
}

function inputOf(state: TransferState) {
  const hasAccount = [state.bankName, state.title, state.iban].some((each) => each.trim());
  return {
    enabled: state.enabled,
    account: hasAccount
      ? {
          bankName: state.bankName.trim(),
          title: state.title.trim(),
          iban: state.iban.trim(),
          raastId: state.raastId.trim() || null,
          instructions: state.instructions.trim(),
        }
      : null,
    discount:
      state.discount === 'NONE'
        ? null
        : state.discount === 'FIXED_AMOUNT'
          ? { amount: state.amount.trim() }
          : {
              percentage: Number(state.percentage.trim().replace(/%$/, '')),
              cap: amountInput(state.cap),
            },
  };
}

const LABELS: Partial<Record<string, MessageKey>> = {
  enabled: 'transfer.enabled',
  bankName: 'transfer.bankName',
  title: 'transfer.title',
  iban: 'transfer.iban',
  raastId: 'transfer.raastId',
  instructions: 'transfer.instructions',
  amount: 'transfer.amount',
  percentage: 'transfer.percentage',
  cap: 'transfer.cap',
};

function BankTransferForm({ settings }: { settings: BankTransferSettingsValue }) {
  const { t } = useLocale();
  const { run, panel } = useRecentAuthentication();
  const save = useAdminMutation<
    { bankTransferSettingsUpdate: SettingsPayloadData },
    { input: ReturnType<typeof inputOf> }
  >(BankTransferSettingsUpdateMutation);
  const [state, setState] = useState(() => stateOf(settings));
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const set = (change: Partial<TransferState>) => setState({ ...state, ...change });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (
      state.discount === 'PERCENTAGE' &&
      !/^\d{1,2}(\.\d{1,2})?$/.test(state.percentage.trim().replace(/%$/, ''))
    ) {
      setProblems([`${t('transfer.percentage')}: ${t('settings.badPercentage')}`]);
      return;
    }
    setProblems([]);
    void run(
      async () => {
        const { bankTransferSettingsUpdate } = await save.mutateAsync({ input: inputOf(state) });
        if (bankTransferSettingsUpdate.userErrors.length > 0) {
          setProblems(
            bankTransferSettingsUpdate.userErrors.map((error) => settingProblem(error, t, LABELS)),
          );
        } else setSaved(true);
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  };

  const discounts: { value: DiscountChoice; label: string }[] = [
    { value: 'NONE', label: t('transfer.discount.NONE') },
    { value: 'PERCENTAGE', label: t('transfer.discount.PERCENTAGE') },
    { value: 'FIXED_AMOUNT', label: t('transfer.discount.FIXED_AMOUNT') },
  ];

  // The panel asking who is signed in has a form of its own, so it sits below this one.
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <FormSection title={t('transfer.account')} hint={t('transfer.accountHint')}>
          <Pair>
            <TextField
              label={t('transfer.bankName')}
              hint={t('transfer.bankNameHint')}
              dir="auto"
              maxLength={100}
              value={state.bankName}
              onChange={(event) => set({ bankName: event.target.value })}
            />
            <TextField
              label={t('transfer.title')}
              hint={t('transfer.titleHint')}
              dir="auto"
              maxLength={100}
              value={state.title}
              onChange={(event) => set({ title: event.target.value })}
            />
          </Pair>
          <TextField
            label={t('transfer.iban')}
            hint={t('transfer.ibanHint')}
            ltr
            autoCapitalize="characters"
            spellCheck={false}
            value={state.iban}
            onChange={(event) => set({ iban: event.target.value })}
          />
          <TextField
            label={t('transfer.raastId')}
            hint={t('transfer.raastIdHint')}
            type="tel"
            inputMode="tel"
            ltr
            value={state.raastId}
            onChange={(event) => set({ raastId: event.target.value })}
          />
          <TextArea
            label={t('transfer.instructions')}
            value={state.instructions}
            onChange={(instructions) => set({ instructions })}
          />
        </FormSection>
        <FormSection title={t('transfer.checkout')}>
          <CheckField
            label={t('transfer.enabled')}
            hint={t('transfer.enabledHint')}
            checked={state.enabled}
            onChange={(enabled) => set({ enabled })}
          />
          <SelectField
            label={t('transfer.discount')}
            value={state.discount}
            options={discounts}
            onChange={(discount) => set({ discount })}
          />
          {state.discount === 'FIXED_AMOUNT' && (
            <TextField
              label={t('transfer.amount')}
              required
              inputMode="decimal"
              ltr
              value={state.amount}
              onChange={(event) => set({ amount: event.target.value })}
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
                onChange={(event) => set({ percentage: event.target.value })}
              />
              <TextField
                label={t('transfer.cap')}
                hint={t('transfer.capHint')}
                inputMode="decimal"
                ltr
                value={state.cap}
                onChange={(event) => set({ cap: event.target.value })}
              />
            </Pair>
          )}
        </FormSection>
        <Problems problems={problems} />
        {saved && <Alert tone="success">{t('settings.saved')}</Alert>}
        <Button type="submit" busy={save.isPending} className="self-start">
          {t('product.save')}
        </Button>
      </form>
      {panel}
    </div>
  );
}

/**
 * Bank transfer (PAY-02, ADR-074): the account customers pay into, by IBAN or Raast; whether
 * checkout offers it beside cash on delivery; and what paying so takes off (ADR-077). Orders keep
 * the account they were told to pay into. The core asks who is signed in to confirm it first.
 */
export function BankTransferPage() {
  const { t } = useLocale();
  const query = useAdminQuery<BankTransferSettingsData>(
    ['bankTransferSettings'],
    BankTransferSettingsQuery,
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
        {t('settings.bankTransfer')}
      </h1>
      <BankTransferForm settings={query.data.bankTransferSettings} />
    </div>
  );
}
