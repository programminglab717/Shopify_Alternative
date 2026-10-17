import { Shirt } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ProductUpdateMutation } from '../api/operations';
import type {
  EasternWear,
  FabricValue,
  ProductDetail,
  ProductUpdateData,
  SeasonValue,
  StitchingValue,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { FormSection, problemText } from './product-form';

export const STITCHING: readonly StitchingValue[] = ['UNSTITCHED', 'SEMI_STITCHED', 'STITCHED'];
export const FABRICS: readonly FabricValue[] = [
  'LAWN',
  'CAMBRIC',
  'COTTON',
  'KHADDAR',
  'KARANDI',
  'LINEN',
  'MARINA',
  'VISCOSE',
  'DOBBY',
  'JACQUARD',
  'CHIFFON',
  'GEORGETTE',
  'ORGANZA',
  'NET',
  'SILK',
  'RAW_SILK',
  'VELVET',
  'JAMAWAR',
  'WOOL',
  'PASHMINA',
];
export const SEASONS: readonly SeasonValue[] = ['SUMMER', 'WINTER', 'FESTIVE', 'ALL_SEASON'];
/** At most this many fabrics, as the core takes. */
const FABRICS_MAX = 3;

const NONE: EasternWear = { stitching: null, pieces: null, fabrics: [], season: null };

/** Whether two sets of attributes say the same. */
function same(a: EasternWear, b: EasternWear): boolean {
  return (
    a.stitching === b.stitching &&
    a.pieces === b.pieces &&
    a.season === b.season &&
    a.fabrics.join() === b.fabrics.join()
  );
}

/**
 * How shoppers choose a suit (CAT-08, ADR-477): whether it comes stitched, in how many pieces,
 * of what fabrics, and for which season, in Hatti's words, which its page shows and shoppers
 * filter by. Each may be left unsaid.
 */
export function EasternWearCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const update = useAdminMutation<
    ProductUpdateData,
    { input: { id: string; easternWear: EasternWear | null } }
  >(ProductUpdateMutation);
  const [stored, setStored] = useState<EasternWear>(product.easternWear ?? NONE);
  const [wear, setWear] = useState<EasternWear>(stored);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = !same(wear, stored);

  const toggle = (fabric: FabricValue, on: boolean) =>
    setWear({
      ...wear,
      fabrics: on ? [...wear.fabrics, fabric] : wear.fabrics.filter((each) => each !== fabric),
    });

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    const easternWear = same(wear, NONE) ? null : wear;
    try {
      const { productUpdate } = await update.mutateAsync({
        input: { id: product.id, easternWear },
      });
      const error = productUpdate.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else {
        setStored(easternWear ?? NONE);
        setSaved(true);
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('easternWear.title')} hint={t('easternWear.hint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField<StitchingValue | ''>
            label={t('easternWear.stitching')}
            value={wear.stitching ?? ''}
            options={[
              { value: '', label: t('easternWear.unsaid') },
              ...STITCHING.map((value) => ({ value, label: t(`easternWear.stitching.${value}`) })),
            ]}
            onChange={(value) => setWear({ ...wear, stitching: value || null })}
          />
          <SelectField<string>
            label={t('easternWear.pieces')}
            value={wear.pieces === null ? '' : String(wear.pieces)}
            options={[
              { value: '', label: t('easternWear.unsaid') },
              ...[1, 2, 3, 4].map((count) => ({
                value: String(count),
                label: t('easternWear.piecesCount', { count }),
              })),
            ]}
            onChange={(value) => setWear({ ...wear, pieces: value ? Number(value) : null })}
          />
          <SelectField<SeasonValue | ''>
            label={t('easternWear.season')}
            value={wear.season ?? ''}
            options={[
              { value: '', label: t('easternWear.unsaid') },
              ...SEASONS.map((value) => ({ value, label: t(`easternWear.season.${value}`) })),
            ]}
            onChange={(value) => setWear({ ...wear, season: value || null })}
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">{t('easternWear.fabrics')}</legend>
          <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('easternWear.fabricsHint', { count: FABRICS_MAX })}
          </p>
          <div className="flex flex-wrap gap-2">
            {FABRICS.map((fabric) => {
              const on = wear.fabrics.includes(fabric);
              return (
                <label
                  key={fabric}
                  className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-control border px-3 ${
                    on ? 'border-[var(--hatti-color-primary)]' : 'border-line'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && wear.fabrics.length >= FABRICS_MAX}
                    onChange={(event) => toggle(fabric, event.target.checked)}
                    className="size-4 accent-[var(--hatti-color-primary)]"
                  />
                  {t(`easternWear.fabric.${fabric}`)}
                </label>
              );
            })}
          </div>
        </fieldset>
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('easternWear.saved')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={update.isPending}
          disabled={!changed}
          icon={<Shirt aria-hidden className="size-5" />}
        >
          {t('easternWear.save')}
        </Button>
      </form>
    </FormSection>
  );
}
