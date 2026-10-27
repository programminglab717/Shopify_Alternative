import { Scissors } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ProductStitchingSetMutation } from '../api/operations';
import type { ProductDetail, ProductStitching, ProductStitchingSetData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection, priceText, problemText } from './product-form';

/** The measurements the core asks for, in the order tailors take them (ADR-802). */
export const MEASUREMENTS = [
  'shirt_length',
  'chest',
  'waist',
  'hips',
  'shoulder',
  'sleeve_length',
  'armhole',
  'neck',
  'wrist',
  'trouser_length',
  'trouser_waist',
  'trouser_bottom',
] as const;

/** What a shirt and trouser are usually stitched to, offered until the shop chooses. */
const USUAL = [
  'shirt_length',
  'chest',
  'waist',
  'hips',
  'shoulder',
  'sleeve_length',
  'trouser_length',
];

interface Draft {
  offered: boolean;
  price: string;
  days: string;
  measurements: string[];
}

const draftOf = (stitching: ProductStitching | null | undefined): Draft => ({
  offered: Boolean(stitching),
  price: priceText(stitching?.price.amount),
  days: stitching ? String(stitching.leadDays) : '7',
  measurements: stitching ? stitching.measurements.map((each) => each.key) : USUAL,
});

/**
 * Stitching offered with an unstitched product (CAT-09, ADR-802): what it adds to each unit's
 * price, the days it adds before shipping, and the measurements its page asks for, in inches;
 * offered or not, saved together.
 */
export function ProductStitchingCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const set = useAdminMutation<ProductStitchingSetData, Record<string, unknown>>(
    ProductStitchingSetMutation,
  );
  const [stored, setStored] = useState(() => draftOf(product.stitching));
  const [draft, setDraft] = useState(stored);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(stored);

  const toggle = (key: string, on: boolean) =>
    setDraft({
      ...draft,
      measurements: on
        ? MEASUREMENTS.filter((each) => each === key || draft.measurements.includes(each))
        : draft.measurements.filter((each) => each !== key),
    });

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    try {
      const { productStitchingSet } = await set.mutateAsync({
        productId: product.id,
        stitching: draft.offered
          ? {
              price: draft.price.replace(/,/g, '').trim(),
              leadDays: Number(draft.days),
              measurements: draft.measurements,
            }
          : null,
      });
      const error = productStitchingSet.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      const now = productStitchingSet.stitching
        ? draftOf(productStitchingSet.stitching)
        : { ...draft, offered: false };
      setStored(now);
      setDraft(now);
      setSaved(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('stitching.title')} hint={t('stitching.hint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        <CheckField
          label={t('stitching.offer')}
          checked={draft.offered}
          onChange={(offered) => setDraft({ ...draft, offered })}
        />
        {draft.offered && (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <TextField
                label={t('stitching.price')}
                inputMode="decimal"
                ltr
                required
                value={draft.price}
                onChange={(event) => setDraft({ ...draft, price: event.target.value })}
              />
              <TextField
                label={t('stitching.days')}
                hint={t('stitching.daysHint')}
                inputMode="numeric"
                ltr
                required
                value={draft.days}
                onChange={(event) => setDraft({ ...draft, days: event.target.value })}
              />
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="font-medium">{t('stitching.measurements')}</legend>
              <div className="grid gap-x-4 sm:grid-cols-2">
                {MEASUREMENTS.map((key) => (
                  <CheckField
                    key={key}
                    label={t(`stitching.measurement.${key}` as MessageKey)}
                    checked={draft.measurements.includes(key)}
                    onChange={(on) => toggle(key, on)}
                  />
                ))}
              </div>
            </fieldset>
          </>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && (
          <Alert tone="success">
            {stored.offered ? t('stitching.savedOn') : t('stitching.savedOff')}
          </Alert>
        )}
        <Button
          type="submit"
          className="self-start"
          busy={set.isPending}
          disabled={!changed}
          icon={<Scissors aria-hidden className="size-5" />}
        >
          {t('stitching.save')}
        </Button>
      </form>
    </FormSection>
  );
}
