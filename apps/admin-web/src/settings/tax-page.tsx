import { Plus, Save, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { TaxSettingsQuery, TaxSettingsUpdateMutation } from '../api/operations';
import type {
  TaxCategory,
  TaxSettings,
  TaxSettingsData,
  TaxSettingsUpdateData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CheckField, Problems, settingProblem } from './settings-form';
import { BackToSettings } from './settings-page';

const LABELS: Partial<Record<string, MessageKey>> = {
  rate: 'tax.rate',
  ntn: 'tax.ntn',
  strn: 'tax.strn',
  code: 'tax.code',
  name: 'tax.name',
};

interface CategoryRow {
  key: number;
  code: string;
  name: string;
  rate: string;
}

/** A percent as typed, "18" or "17.5%", or null where it is not one. */
function percentOf(text: string): number | null {
  const value = Number(text.replace(/%\s*$/, '').trim());
  return text.trim() !== '' && Number.isFinite(value) ? value : null;
}

/** What a price holds of tax at `rate`, as an example: Rs 1,180 at 18% holds Rs 180. */
function example(rate: number): { price: string; tax: string } {
  const price = 1000 * (1 + rate / 100);
  return { price: price.toFixed(2), tax: (price - 1000).toFixed(2) };
}

/** The settings as the core would keep them from what the form holds. */
function inputOf(
  charges: boolean,
  rate: string,
  taxDelivery: boolean,
  ntn: string,
  strn: string,
  rows: Omit<CategoryRow, 'key'>[],
) {
  return {
    rate: charges ? percentOf(rate) : null,
    taxDelivery,
    ntn: ntn.trim() || null,
    strn: strn.trim() || null,
    categories: rows.map((row) => ({
      code: row.code.trim(),
      name: row.name.trim(),
      rate: percentOf(row.rate),
    })),
  };
}

function TaxForm({ settings }: { settings: TaxSettings }) {
  const { t } = useLocale();
  const update = useAdminMutation<TaxSettingsUpdateData, { input: Record<string, unknown> }>(
    TaxSettingsUpdateMutation,
  );
  const next = useRef(0);
  const keyed = (categories: TaxCategory[]) =>
    categories.map((each) => ({
      key: (next.current += 1),
      code: each.code,
      name: each.name,
      rate: String(each.rate),
    }));
  const [charges, setCharges] = useState(settings.rate !== null);
  const [rate, setRate] = useState(settings.rate === null ? '' : String(settings.rate));
  const [taxDelivery, setTaxDelivery] = useState(settings.taxDelivery);
  const [ntn, setNtn] = useState(settings.ntn ?? '');
  const [strn, setStrn] = useState(settings.strn ?? '');
  const [rows, setRows] = useState<CategoryRow[]>(() => keyed(settings.categories));
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const now = inputOf(charges, rate, taxDelivery, ntn, strn, rows);
  const was = inputOf(
    settings.rate !== null,
    settings.rate === null ? '' : String(settings.rate),
    settings.taxDelivery,
    settings.ntn ?? '',
    settings.strn ?? '',
    settings.categories.map((each) => ({ ...each, rate: String(each.rate) })),
  );
  const changes = Object.fromEntries(
    Object.entries(now).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(was[key as keyof typeof was]),
    ),
  );
  const changed = Object.keys(changes).length > 0;
  const shown = percentOf(rate);

  const setRow = (index: number, change: Partial<CategoryRow>) =>
    setRows((all) => all.map((row, at) => (at === index ? { ...row, ...change } : row)));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    if (charges && shown === null) {
      setProblems([`${t('tax.rate')}: ${t('tax.badRate')}`]);
      return;
    }
    if (now.categories.some((each) => each.rate === null)) {
      setProblems([`${t('tax.categoryRate')}: ${t('tax.badRate')}`]);
      return;
    }
    setProblems([]);
    setSaved(false);
    try {
      const { taxSettingsUpdate } = await update.mutateAsync({ input: changes });
      if (taxSettingsUpdate.userErrors.length > 0 || !taxSettingsUpdate.taxSettings) {
        setProblems(
          taxSettingsUpdate.userErrors.map((error) =>
            settingProblem(error, t, LABELS, (field) => {
              const at = field.indexOf('categories');
              const index = Number(field[at + 1]);
              return at >= 0 && Number.isInteger(index)
                ? t('tax.categoryNumber', { number: index + 1 })
                : null;
            }),
          ),
        );
        return;
      }
      const kept = taxSettingsUpdate.taxSettings;
      setRows(keyed(kept.categories));
      setRate(kept.rate === null ? '' : String(kept.rate));
      setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('tax.charge')} hint={t('tax.chargeHint')}>
        <CheckField
          label={t('tax.charges')}
          hint={t(charges ? 'tax.chargesOn' : 'tax.chargesOff')}
          checked={charges}
          onChange={setCharges}
        />
        {charges && (
          <>
            <TextField
              label={t('tax.rate')}
              hint={
                shown !== null && shown > 0
                  ? t('tax.rateExample', {
                      rate: String(shown),
                      price: formatMoney(example(shown).price),
                      tax: formatMoney(example(shown).tax),
                    })
                  : t('tax.rateHint')
              }
              inputMode="decimal"
              ltr
              className="w-40"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            />
            <CheckField
              label={t('tax.delivery')}
              hint={t('tax.deliveryHint')}
              checked={taxDelivery}
              onChange={setTaxDelivery}
            />
          </>
        )}
      </FormSection>

      <FormSection title={t('tax.registration')} hint={t('tax.registrationHint')}>
        <TextField
          label={t('tax.ntn')}
          hint={t('tax.ntnHint')}
          ltr
          value={ntn}
          onChange={(event) => setNtn(event.target.value)}
        />
        <TextField
          label={t('tax.strn')}
          hint={t('tax.strnHint')}
          ltr
          value={strn}
          onChange={(event) => setStrn(event.target.value)}
        />
      </FormSection>

      <FormSection title={t('tax.categories')} hint={t('tax.categoriesHint')}>
        {rows.length > 0 && (
          <ol className="flex flex-col gap-2">
            {rows.map((row, index) => {
              const number = index + 1;
              return (
                <li
                  key={row.key}
                  className="flex flex-wrap items-end gap-3 rounded-control border border-line p-3"
                >
                  <TextField
                    label={t('tax.nameOf', { number })}
                    dir="auto"
                    className="min-w-40 flex-1"
                    value={row.name}
                    onChange={(event) => setRow(index, { name: event.target.value })}
                  />
                  <TextField
                    label={t('tax.codeOf', { number })}
                    ltr
                    className="w-36"
                    value={row.code}
                    onChange={(event) => setRow(index, { code: event.target.value.toUpperCase() })}
                  />
                  <TextField
                    label={t('tax.rateOf', { number })}
                    inputMode="decimal"
                    ltr
                    className="w-24"
                    value={row.rate}
                    onChange={(event) => setRow(index, { rate: event.target.value })}
                  />
                  <Button
                    variant="danger"
                    aria-label={t('tax.removeCategory', { number })}
                    icon={<Trash2 aria-hidden className="size-5" />}
                    onClick={() => setRows((all) => all.filter((_, at) => at !== index))}
                  />
                </li>
              );
            })}
          </ol>
        )}
        {rows.length < 20 && (
          <Button
            variant="secondary"
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() =>
              setRows((all) => [...all, { key: (next.current += 1), code: '', name: '', rate: '' }])
            }
          >
            {t('tax.addCategory')}
          </Button>
        )}
      </FormSection>

      <Problems problems={problems} />
      {saved && !changed && <Alert tone="success">{t('tax.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={update.isPending}
        disabled={!changed}
        icon={<Save aria-hidden className="size-5" />}
      >
        {t('tax.save')}
      </Button>
    </form>
  );
}

/**
 * The shop's sales tax (TAX-01, ADR-096, ADR-097): whether it charges it and at what rate,
 * included in its prices, on delivery too; the NTN and STRN its invoices name; and rates of its
 * own for some products. For orders placed from then on; those placed keep theirs.
 */
export function TaxPage() {
  const { t } = useLocale();
  const query = useAdminQuery<TaxSettingsData>(['taxSettings'], TaxSettingsQuery);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('tax.title')}
      </h1>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <TaxForm settings={query.data.taxSettings} />
      )}
    </div>
  );
}
