import { useState } from 'react';
import { InventoryItemUpdateMutation } from '../api/operations';
import type { ProductDetail, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Alert } from '../ui/feedback';
import { FormSection, problemText } from './product-form';

type Variant = ProductDetail['variants'][number];
type Input = { tracked?: boolean; inventoryPolicy?: 'CONTINUE' | 'DENY' };

/** One variant's rules: its stock counted or not, and sold or not once none is left. */
function VariantRules({ variant, named }: { variant: Variant; named: boolean }) {
  const { t } = useLocale();
  const update = useAdminMutation<
    { inventoryItemUpdate: { userErrors: UserError[] } },
    { id: string; input: Input }
  >(InventoryItemUpdateMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const item = variant.inventoryItem;
  // Shown as chosen at once, and put back if the core refuses.
  const [rules, setRules] = useState({ tracked: item.tracked, policy: item.inventoryPolicy });
  const selling = rules.policy === 'CONTINUE';

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
  `${variant.id}-${variant.inventoryItem.tracked}-${variant.inventoryItem.inventoryPolicy}`;

/**
 * Stock rules (INV-01): whether each variant's stock is counted, so that sales are checked
 * against it, and whether it goes on selling once none is available, as for made-to-order suits,
 * its stock going below zero. Each change is saved at once.
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
