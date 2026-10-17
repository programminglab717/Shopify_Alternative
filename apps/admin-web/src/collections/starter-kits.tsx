import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { StarterKitApplyMutation, StarterKitsQuery } from '../api/operations';
import type {
  StarterKitApplied,
  StarterKitApplyData,
  StarterKitsData,
  StarterKitValue,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';

export const KITS: readonly StarterKitValue[] = [
  'FASHION',
  'JEWELLERY',
  'BEAUTY',
  'ELECTRONICS',
  'GROCERY',
];

/** What applying a kit made, in words. */
export function KitApplied({ applied }: { applied: StarterKitApplied }) {
  const { t } = useLocale();
  return (
    <Alert tone="success">
      {t('starterKits.applied', {
        collections: applied.collectionsMade,
        charts: applied.sizeChartsMade,
        links: applied.menuLinksAdded,
      })}{' '}
      {t('starterKits.tagHint')}
    </Alert>
  );
}

/**
 * Vertical starter kits (ONB-13, ADR-486): what a new shop sells by, set up in one go: the kit's
 * collections, filled by its products' tags, its size charts and links in the main menu.
 */
export function StarterKitCard({ onApplied }: { onApplied: (applied: StarterKitApplied) => void }) {
  const { t } = useLocale();
  const kits = useAdminQuery<StarterKitsData>(['starterKits'], StarterKitsQuery);
  const apply = useAdminMutation<StarterKitApplyData, { kit: StarterKitValue }>(
    StarterKitApplyMutation,
  );
  const [kit, setKit] = useState<StarterKitValue>('FASHION');
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = kits.data?.starterKits.find((each) => each.kit === kit);

  const onApply = async () => {
    setProblem(null);
    try {
      const { starterKitApply } = await apply.mutateAsync({ kit });
      onApplied(starterKitApply);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="flex items-center gap-2 font-semibold">
        <Sparkles aria-hidden className="size-5 text-secondary" />
        {t('starterKits.title')}
      </h2>
      <p className="text-secondary">{t('starterKits.hint')}</p>
      <SelectField<StarterKitValue>
        label={t('starterKits.kit')}
        value={kit}
        options={KITS.map((value) => ({ value, label: t(`starterKits.kit.${value}`) }))}
        onChange={setKit}
      />
      {chosen && (
        <p className="text-[length:var(--hatti-type-body-sm-size)]">
          <span className="text-secondary">{t('starterKits.makes')} </span>
          {[
            ...chosen.collections.map((collection) => collection.title),
            ...chosen.sizeCharts.map((chart) => t('starterKits.sizeChart', { name: chart })),
          ].join(', ')}
        </p>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button
        className="self-start"
        busy={apply.isPending}
        icon={<Sparkles aria-hidden className="size-5" />}
        onClick={() => void onApply()}
      >
        {t('starterKits.apply')}
      </Button>
    </Card>
  );
}
