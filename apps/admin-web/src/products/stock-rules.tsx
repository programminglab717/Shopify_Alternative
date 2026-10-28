import { FBR_DEFAULT_UNIT, FBR_UNITS } from '@hatti/pk';
import { useState } from 'react';
import { InventoryItemUpdateMutation } from '../api/operations';
import type { ProductDetail, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { CheckField, SelectField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection, problemText } from './product-form';

type Variant = ProductDetail['variants'][number];
type Input = {
  tracked?: boolean;
  inventoryPolicy?: 'CONTINUE' | 'DENY';
  harmonizedSystemCode?: string;
  fbrUnitOfMeasure?: string;
  sroScheduleNumber?: string;
  sroItemSerialNumber?: string;
};

type Item = Variant['inventoryItem'];

/** FBR's unit and SRO for one variant (CAT-19, ADR-895), each saved as it is chosen or left. */
function FbrFields({
  item,
  title,
  save,
}: {
  item: Item;
  title: string | null;
  save: (input: Input) => Promise<{ error: string | null; item: Partial<Item> | null }>;
}) {
  const { t } = useLocale();
  const [unit, setUnit] = useState(item.fbrUnitOfMeasure ?? FBR_DEFAULT_UNIT);
  const [schedule, setSchedule] = useState(item.sroScheduleNumber ?? '');
  const [serial, setSerial] = useState(item.sroItemSerialNumber ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const kept = {
    unit: item.fbrUnitOfMeasure ?? FBR_DEFAULT_UNIT,
    schedule: item.sroScheduleNumber ?? '',
    serial: item.sroItemSerialNumber ?? '',
  };
  const [saved, setSaved] = useState(kept);

  const change = async (input: Input) => {
    setProblem(null);
    const result = await save(input);
    if (result.error) {
      setProblem(result.error);
      return;
    }
    const now = {
      unit: result.item?.fbrUnitOfMeasure ?? FBR_DEFAULT_UNIT,
      schedule: result.item?.sroScheduleNumber ?? '',
      serial: result.item?.sroItemSerialNumber ?? '',
    };
    setSaved(now);
    setUnit(now.unit);
    setSchedule(now.schedule);
    setSerial(now.serial);
  };
  const of = (label: string) => (title ? t('stockRules.fieldOf', { label, title }) : label);

  return (
    <details className="rounded-control border border-line p-3">
      <summary className="cursor-pointer font-medium">{of(t('stockRules.fbr'))}</summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-secondary">{t('stockRules.fbrHint')}</p>
        <SelectField
          label={of(t('stockRules.unit'))}
          value={unit}
          options={FBR_UNITS.map((each) => ({ value: each, label: each }))}
          onChange={(value) => {
            setUnit(value);
            void change({ fbrUnitOfMeasure: value === FBR_DEFAULT_UNIT ? '' : value });
          }}
        />
        <TextField
          label={of(t('stockRules.sroSchedule'))}
          hint={t('stockRules.sroScheduleHint')}
          maxLength={50}
          value={schedule}
          onChange={(event) => setSchedule(event.target.value)}
          onBlur={() => {
            if (schedule.trim() !== saved.schedule) void change({ sroScheduleNumber: schedule });
          }}
        />
        <TextField
          label={of(t('stockRules.sroSerial'))}
          maxLength={20}
          ltr
          value={serial}
          onChange={(event) => setSerial(event.target.value)}
          onBlur={() => {
            if (serial.trim() !== saved.serial) void change({ sroItemSerialNumber: serial });
          }}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
      </div>
    </details>
  );
}

/** An HS code as typed, its dots and spaces aside, as the core keeps it. */
const hsDigits = (typed: string) => typed.replace(/[\s.]/g, '');

/**
 * One variant's rules: its stock counted or not, sold or not once none is left, and its HS code,
 * saved when the field is left.
 */
function VariantRules({ variant, named }: { variant: Variant; named: boolean }) {
  const { t } = useLocale();
  const update = useAdminMutation<
    {
      inventoryItemUpdate: {
        inventoryItem: Partial<Item> | null;
        userErrors: UserError[];
      };
    },
    { id: string; input: Input }
  >(InventoryItemUpdateMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const item = variant.inventoryItem;
  // Shown as chosen at once, and put back if the core refuses.
  const [rules, setRules] = useState({ tracked: item.tracked, policy: item.inventoryPolicy });
  const selling = rules.policy === 'CONTINUE';
  const kept = item.harmonizedSystemCode ?? '';
  const [hsCode, setHsCode] = useState(kept);
  const [hsProblem, setHsProblem] = useState<string | null>(null);

  const saveHsCode = async () => {
    if (hsDigits(hsCode) === kept) return;
    setHsProblem(null);
    try {
      const result = (
        await update.mutateAsync({ id: item.id, input: { harmonizedSystemCode: hsCode.trim() } })
      ).inventoryItemUpdate;
      const error = result.userErrors[0];
      if (error) setHsProblem(error.message);
      else setHsCode(result.inventoryItem?.harmonizedSystemCode ?? '');
    } catch (failure) {
      setHsProblem(errorText(failure, t));
    }
  };

  /** Saves FBR's fields, saying what the core kept or why it refused. */
  const saveFbr = async (input: Input) => {
    try {
      const result = (await update.mutateAsync({ id: item.id, input })).inventoryItemUpdate;
      const error = result.userErrors[0];
      return { error: error ? error.message : null, item: result.inventoryItem };
    } catch (failure) {
      return { error: errorText(failure, t), item: null };
    }
  };

  const change = async (input: Input) => {
    const before = rules;
    setProblem(null);
    setRules({
      tracked: input.tracked ?? rules.tracked,
      policy: input.inventoryPolicy ?? rules.policy,
    });
    try {
      const error = (await update.mutateAsync({ id: item.id, input })).inventoryItemUpdate
        .userErrors[0];
      if (error) {
        setRules(before);
        setProblem(problemText(error, t));
      }
    } catch (failure) {
      setRules(before);
      setProblem(errorText(failure, t));
    }
  };

  const fields = (
    <>
      <CheckField
        label={named ? t('stockRules.trackOf', { title: variant.title }) : t('stockRules.track')}
        hint={t('stockRules.trackHint')}
        checked={rules.tracked}
        onChange={(tracked) => void change({ tracked })}
      />
      {rules.tracked && (
        <CheckField
          label={
            named ? t('stockRules.continueOf', { title: variant.title }) : t('stockRules.continue')
          }
          hint={t('stockRules.continueHint')}
          checked={selling}
          onChange={(keep) => void change({ inventoryPolicy: keep ? 'CONTINUE' : 'DENY' })}
        />
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <TextField
        label={named ? t('stockRules.hsCodeOf', { title: variant.title }) : t('stockRules.hsCode')}
        hint={t('stockRules.hsHint')}
        error={hsProblem}
        ltr
        inputMode="decimal"
        maxLength={20}
        value={hsCode}
        onChange={(event) => setHsCode(event.target.value)}
        onBlur={() => void saveHsCode()}
      />
      <FbrFields item={item} title={named ? variant.title : null} save={saveFbr} />
    </>
  );
  if (!named) return <div className="flex flex-col gap-2">{fields}</div>;
  return (
    <li className="flex flex-col gap-2 py-3">
      <span className="font-medium" dir="auto">
        {variant.title}
      </span>
      {fields}
    </li>
  );
}

/** A variant's rules as the core has them: shown afresh when they change. */
const keyOf = (variant: Variant) =>
  [
    variant.id,
    variant.inventoryItem.tracked,
    variant.inventoryItem.inventoryPolicy,
    variant.inventoryItem.harmonizedSystemCode ?? '',
  ].join('-');

/**
 * Stock rules (INV-01): whether each variant's stock is counted, so that sales are checked
 * against it, and whether it goes on selling once none is available, as for made-to-order suits,
 * its stock going below zero; and its HS code, which FBR is told as its PCT code (CAT-19,
 * ADR-557). Each change is saved at once.
 */
export function StockRules({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const single = product.variants.length === 1;
  return (
    <FormSection title={t('stockRules.title')} hint={t('stockRules.hint')}>
      {single ? (
        <VariantRules
          key={keyOf(product.variants[0]!)}
          variant={product.variants[0]!}
          named={false}
        />
      ) : (
        <ul className="divide-y divide-line">
          {product.variants.map((variant) => (
            <VariantRules key={keyOf(variant)} variant={variant} named />
          ))}
        </ul>
      )}
    </FormSection>
  );
}
