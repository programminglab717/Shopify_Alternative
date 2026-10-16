import { useState } from 'react';
import { ProductUpdateMutation } from '../api/operations';
import type { ProductDetail, ProductUpdateData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Alert } from '../ui/feedback';
import { FormSection, problemText } from './product-form';

/**
 * Whether the product is sold as a gift card (CAT-12, ADR-451): each one paid for is a card
 * worth its price, its code sent to the buyer on WhatsApp. Saved at once, and put back if the
 * core refuses.
 */
export function GiftCardProduct({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const update = useAdminMutation<ProductUpdateData, { input: { id: string; giftCard: boolean } }>(
    ProductUpdateMutation,
  );
  const [on, setOn] = useState(product.isGiftCard === true);
  const [problem, setProblem] = useState<string | null>(null);

  const change = async (giftCard: boolean) => {
    setProblem(null);
    setOn(giftCard);
    try {
      const error = (await update.mutateAsync({ input: { id: product.id, giftCard } }))
        .productUpdate.userErrors[0];
      if (error) {
        setOn(!giftCard);
        setProblem(problemText(error, t));
      }
    } catch (failure) {
      setOn(!giftCard);
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('giftCardProduct.title')} hint={t('giftCardProduct.hint')}>
      <div className="flex flex-col gap-2">
        <CheckField
          label={t('giftCardProduct.on')}
          hint={t('giftCardProduct.onHint')}
          checked={on}
          onChange={(giftCard) => void change(giftCard)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
      </div>
    </FormSection>
  );
}
