import { CircleCheck, CircleDashed, Info, MessageSquare, Plus, Save, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { TaxSettingsQuery, TaxSettingsUpdateMutation } from '../api/operations';
import type {
  FilerStatus,
  TaxCategory,
  TaxProvince,
  TaxSettings,
  TaxSettingsData,
  TaxSettingsUpdateData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FbrPosSection } from './fbr-pos';
import { CheckField, Problems, SelectField, settingProblem } from './settings-form';
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

export const TAX_PROVINCES: readonly TaxProvince[] = [
  'PUNJAB',
  'SINDH',
  'KHYBER_PAKHTUNKHWA',
  'BALOCHISTAN',
  'ISLAMABAD',
  'GILGIT_BALTISTAN',
  'AZAD_KASHMIR',
];

const FILER_STATUSES: readonly FilerStatus[] = ['UNKNOWN', 'ACTIVE', 'INACTIVE'];

/** The rest of the tax profile as the form holds it (ADR-500): no province as ''. */
interface Profile {
  province: TaxProvince | '';
  filerStatus: FilerStatus;
  tier1: boolean;
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
  profile: Profile,
) {
  return {
    rate: charges ? percentOf(rate) : null,
    taxDelivery,
    ntn: ntn.trim() || null,
    strn: strn.trim() || null,
    province: profile.province || null,
    filerStatus: profile.filerStatus,
    tier1: profile.tier1,
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
  const [profile, setProfile] = useState<Profile>({
    province: settings.province ?? '',
    filerStatus: settings.filerStatus,
    tier1: settings.tier1,
  });
  const [rows, setRows] = useState<CategoryRow[]>(() => keyed(settings.categories));
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const now = inputOf(charges, rate, taxDelivery, ntn, strn, rows, profile);
  const was = inputOf(
    settings.rate !== null,
    settings.rate === null ? '' : String(settings.rate),
    settings.taxDelivery,
    settings.ntn ?? '',
    settings.strn ?? '',
    settings.categories.map((each) => ({ ...each, rate: String(each.rate) })),
    {
      province: settings.province ?? '',
      filerStatus: settings.filerStatus,
      tier1: settings.tier1,
    },
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
        <SelectField<TaxProvince | ''>
          label={t('tax.province')}
          value={profile.province}
          options={[
            { value: '', label: t('tax.provinceNone') },
            ...TAX_PROVINCES.map((each) => ({ value: each, label: t(`tax.province.${each}`) })),
          ]}
          onChange={(province) => setProfile((was) => ({ ...was, province }))}
        />
        <SelectField<FilerStatus>
          label={t('tax.filerStatus')}
          value={profile.filerStatus}
          options={FILER_STATUSES.map((each) => ({ value: each, label: t(`tax.filer.${each}`) }))}
          onChange={(filerStatus) => setProfile((was) => ({ ...was, filerStatus }))}
        />
        <CheckField
          label={t('tax.tier1')}
          hint={t('tax.tier1Hint')}
          checked={profile.tier1}
          onChange={(tier1) => setProfile((was) => ({ ...was, tier1 }))}
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

/** Where FBR's people register sellers, file returns and keep the Active Taxpayers List. */
export const FBR_IRIS_URL = 'https://iris.fbr.gov.pk';

/**
 * Registering with FBR as an online seller must (ONB-12, ADR-500), as the shop's profile saved
 * says: each step done or to do, notes for a shop like it, and what its filer status means it
 * is withheld.
 */
function TaxGuidance({ settings }: { settings: TaxSettings }) {
  const { t } = useLocale();
  const left = settings.guidance.filter((step) => step.status === 'TO_DO').length;
  return (
    <FormSection
      title={t('tax.guidance')}
      hint={left === 0 ? t('tax.guidanceDone') : t('tax.guidanceLeft', { count: left })}
    >
      <ol className="flex flex-col gap-3">
        {settings.guidance.map((step) => {
          const Icon =
            step.status === 'DONE' ? CircleCheck : step.status === 'NOTE' ? Info : CircleDashed;
          return (
            <li key={step.code} className="flex items-start gap-2" data-status={step.status}>
              <Icon
                aria-hidden
                className={`mt-0.5 size-5 shrink-0 ${step.status === 'DONE' ? 'text-success' : 'text-secondary'}`}
              />
              <div className="flex flex-col gap-0.5">
                <p className="font-medium">
                  {t(`tax.step.${step.code}`)}
                  {step.status === 'DONE' && (
                    <span className="sr-only"> ({t('tax.stepDone')})</span>
                  )}
                </p>
                <p className="text-sm text-secondary">{t(`tax.step.${step.code}.hint`)}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-sm">
        {t('tax.withholding', {
          digital: settings.withholding.digitalPercent,
          cod: settings.withholding.cashOnDeliveryPercent,
        })}
      </p>
      <p className="text-sm text-secondary">
        {t('tax.guidanceWhere')}{' '}
        <a
          href={FBR_IRIS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-4 hover:underline"
        >
          {t('tax.iris')}
        </a>
      </p>
    </FormSection>
  );
}

/** A CNIC's 13 digits as typed, "35202-1234567-1", or null. */
const cnicOf = (typed: string) => {
  const digits = typed.replace(/[\s-]/g, '');
  return /^\d{13}$/.test(digits) ? digits : null;
};

/** An SMS to FBR's 9966 written for the phone's messages app, on Android and iOS alike. */
const smsTo9966 = (body: string) => `sms:9966?&body=${encodeURIComponent(body)}`;

/**
 * Checking the Active Taxpayers List (TAX-08, ADR-837): when the shop last said whether it is
 * on it, and why to check again, a new list each 1 March; the SMS FBR answers, written for the
 * phone's messages app from its NTN, or from a CNIC typed here and kept nowhere; and what it
 * found, said in a tap.
 */
function FilerCheck({ settings }: { settings: TaxSettings }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const update = useAdminMutation<TaxSettingsUpdateData, { input: Record<string, unknown> }>(
    TaxSettingsUpdateMutation,
  );
  const [cnic, setCnic] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const check = settings.filerCheck;
  const body = check.smsBody ?? (cnicOf(cnic) && `ATL ${cnicOf(cnic)}`);

  const say = async (filerStatus: FilerStatus) => {
    setProblem(null);
    try {
      const { taxSettingsUpdate } = await update.mutateAsync({ input: { filerStatus } });
      const error = taxSettingsUpdate.userErrors[0];
      if (error) setProblem(error.message);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('tax.filerCheck')} hint={t('tax.filerCheckHint')}>
      {check.due === 'NEVER' ? (
        <Alert tone="warning">{t('tax.filerNever')}</Alert>
      ) : check.due === 'NEW_LIST' ? (
        <Alert tone="warning">
          {t('tax.filerNewList', { date: formatDate(check.listOf, timezone, locale) })}
        </Alert>
      ) : (
        <p className="text-sm">
          {t(settings.filerStatus === 'ACTIVE' ? 'tax.filerOn' : 'tax.filerOff', {
            date: formatDate(check.checkedAt!, timezone, locale),
          })}
        </p>
      )}
      {!check.smsBody && (
        <TextField
          label={t('tax.filerCnic')}
          hint={t('tax.filerCnicHint')}
          value={cnic}
          inputMode="numeric"
          ltr
          placeholder="35202-1234567-1"
          onChange={(event) => setCnic(event.target.value)}
        />
      )}
      {body && (
        <a
          href={smsTo9966(body)}
          className="flex items-center gap-2 self-start font-medium text-primary underline-offset-4 hover:underline"
        >
          <MessageSquare aria-hidden className="size-5" />
          {t('tax.filerSms', { body })}
        </a>
      )}
      <p className="text-sm text-secondary">{t('tax.filerAnswer')}</p>
      <span className="flex flex-wrap gap-2">
        <Button variant="secondary" busy={update.isPending} onClick={() => void say('ACTIVE')}>
          {t('tax.filerSayOn')}
        </Button>
        <Button variant="secondary" busy={update.isPending} onClick={() => void say('INACTIVE')}>
          {t('tax.filerSayOff')}
        </Button>
      </span>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
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
        <>
          <TaxGuidance settings={query.data.taxSettings} />
          <FilerCheck settings={query.data.taxSettings} />
          {/* Afresh once the filer status is said above, so the form never sends the old one. */}
          <TaxForm key={query.data.taxSettings.filerStatus} settings={query.data.taxSettings} />
          <FbrPosSection settings={query.data.taxSettings} />
        </>
      )}
    </div>
  );
}
