import { Coins } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { CurrenciesQuery, PresentmentCurrenciesSetMutation } from '../api/operations';
import type {
  CurrenciesData,
  CurrencyRate,
  PresentmentCurrenciesSetData,
  PresentmentCurrency,
  PresentmentRounding,
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
import { CheckField, SelectField } from './settings-form';

/** The currencies a shop may show its prices in, in its picker's order. */
const CURRENCIES = ['AED', 'SAR', 'GBP', 'USD', 'CAD', 'EUR'] as const;

interface Row {
  shown: boolean;
  fixedRate: string;
  rounding: PresentmentRounding;
}

const rowsOf = (currencies: readonly PresentmentCurrency[]): Record<string, Row> =>
  Object.fromEntries(
    CURRENCIES.map((code) => {
      const kept = currencies.find((each) => each.currencyCode === code);
      return [
        code,
        {
          shown: Boolean(kept),
          fixedRate: kept?.fixedRate ?? '',
          rounding: kept?.rounding ?? 'exact',
        },
      ];
    }),
  );

/**
 * Currencies (OS-21, ADR-865): those the shop shows its prices in besides rupees, for shoppers
 * abroad, each at a rate it fixes or the day's, and rounded as it asks. Checkout charges rupees.
 */
export function CurrenciesPage() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<CurrenciesData>(['currencies'], CurrenciesQuery);
  const save = useAdminMutation<
    PresentmentCurrenciesSetData,
    { input: { currencyCode: string; fixedRate: string | null; rounding: PresentmentRounding }[] }
  >(PresentmentCurrenciesSetMutation);
  const [rows, setRows] = useState<Record<string, Row> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const writes = can(shop, 'write_settings');

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
    const current = rows ?? rowsOf(query.data.presentmentCurrencies);
    const change = (code: string, patch: Partial<Row>) => {
      setSaved(false);
      setRows({ ...current, [code]: { ...current[code]!, ...patch } });
    };
    const onSave = async (event: FormEvent) => {
      event.preventDefault();
      setProblem(null);
      setBusy(true);
      try {
        const done = (
          await save.mutateAsync({
            input: CURRENCIES.filter((code) => current[code]!.shown).map((code) => ({
              currencyCode: code,
              fixedRate: current[code]!.fixedRate.trim() || null,
              rounding: current[code]!.rounding,
            })),
          })
        ).presentmentCurrenciesSet;
        if (done.userErrors[0]) {
          setProblem(problemText(done.userErrors[0], t));
        } else {
          setRows(null);
          setSaved(true);
        }
      } catch (failure) {
        setProblem(errorText(failure, t));
      }
      setBusy(false);
    };
    return (
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        {CURRENCIES.map((code) => (
          <CurrencyCard
            key={code}
            code={code}
            row={current[code]!}
            rate={query.data.currencyRates.find((each) => each.currencyCode === code) ?? null}
            disabled={!writes}
            onChange={(patch) => change(code, patch)}
          />
        ))}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && <Alert tone="success">{t('currencies.saved')}</Alert>}
        {writes && (
          <Button type="submit" className="self-start" busy={busy}>
            {t('currencies.save')}
          </Button>
        )}
      </form>
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Coins aria-hidden className="size-7 text-secondary" />
        {t('settings.currencies')}
      </h1>
      <p className="text-secondary">{t('currencies.hint')}</p>
      {body()}
    </div>
  );
}

function CurrencyCard({
  code,
  row,
  rate,
  disabled,
  onChange,
}: {
  code: string;
  row: Row;
  rate: CurrencyRate | null;
  disabled: boolean;
  onChange: (patch: Partial<Row>) => void;
}) {
  const { t } = useLocale();
  const name = t(`currencies.name.${code}` as MessageKey);
  return (
    <Card className="flex flex-col gap-3 p-4">
      <CheckField
        label={t('currencies.show', { code, name })}
        checked={row.shown}
        onChange={(shown) => !disabled && onChange({ shown })}
      />
      {row.shown && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t('currencies.rate', { code })}
            hint={
              rate
                ? t('currencies.rateToday', { code, rate: rate.rate, date: rate.rateDate })
                : t('currencies.rateNone')
            }
            inputMode="decimal"
            value={row.fixedRate}
            onChange={(event) => onChange({ fixedRate: event.target.value })}
            disabled={disabled}
            ltr
          />
          <SelectField
            label={t('currencies.rounding')}
            value={row.rounding}
            options={[
              { value: 'exact', label: t('currencies.roundExact') },
              { value: 'whole', label: t('currencies.roundWhole') },
              { value: 'ninety_nine', label: t('currencies.roundNinetyNine') },
            ]}
            onChange={(rounding) => onChange({ rounding })}
            disabled={disabled}
          />
        </div>
      )}
    </Card>
  );
}
