import { Tags } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ProductCategoriesQuery, ProductUpdateMutation } from '../api/operations';
import type {
  ProductCategoriesData,
  ProductConditionValue,
  ProductDetail,
  ProductUpdateData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { FormSection, problemText } from './product-form';

export const CONDITIONS: readonly ProductConditionValue[] = ['NEW', 'REFURBISHED', 'USED'];

interface Taxonomy {
  category: string | null;
  condition: ProductConditionValue;
}

/**
 * What the product is in Google's product taxonomy, and whether it is new (CAT-18, ADR-483),
 * which the shop's catalog feed gives Google Shopping and Meta. A category is chosen from those
 * Hatti offers; none leaves it unsaid.
 */
export function CategoryCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const categories = useAdminQuery<ProductCategoriesData>(
    ['productCategories'],
    ProductCategoriesQuery,
  );
  const update = useAdminMutation<
    ProductUpdateData,
    {
      input: { id: string; category: string | null; condition: ProductConditionValue };
    }
  >(ProductUpdateMutation);
  const [stored, setStored] = useState<Taxonomy>({
    category: product.category ?? null,
    condition: product.condition ?? 'NEW',
  });
  const [taxonomy, setTaxonomy] = useState<Taxonomy>(stored);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = taxonomy.category !== stored.category || taxonomy.condition !== stored.condition;

  // The product's own category stays a choice while the list loads, or if it is no longer in it.
  const offered = categories.data?.productCategories ?? [];
  const paths =
    stored.category && !offered.includes(stored.category) ? [stored.category, ...offered] : offered;

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    try {
      const { productUpdate } = await update.mutateAsync({
        input: { id: product.id, ...taxonomy },
      });
      const error = productUpdate.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else {
        setStored(taxonomy);
        setSaved(true);
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('productCategory.title')} hint={t('productCategory.hint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <SelectField<string>
            label={t('productCategory.category')}
            value={taxonomy.category ?? ''}
            options={[
              { value: '', label: t('productCategory.none') },
              ...paths.map((path) => ({ value: path, label: path })),
            ]}
            onChange={(value) => setTaxonomy({ ...taxonomy, category: value || null })}
          />
          <SelectField<ProductConditionValue>
            label={t('productCategory.condition')}
            value={taxonomy.condition}
            options={CONDITIONS.map((value) => ({
              value,
              label: t(`productCategory.condition.${value}`),
            }))}
            onChange={(value) => setTaxonomy({ ...taxonomy, condition: value })}
          />
        </div>
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('productCategory.saved')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={update.isPending}
          disabled={!changed}
          icon={<Tags aria-hidden className="size-5" />}
        >
          {t('productCategory.save')}
        </Button>
      </form>
    </FormSection>
  );
}
