import { Crop } from 'lucide-react';
import { useState } from 'react';
import { ProductAutoCropMediaMutation } from '../api/operations';
import type { ImageAspectRatio, ProductAutoCropMediaData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { problemText } from './product-form';

/**
 * Auto-crop (CAT-21, ADR-503): the product's ready photos cropped to the product in each, in the
 * shape the shop's theme shows them in. The whole of each is kept, to be cropped again.
 */
export function AutoCrop({ productId }: { productId: string }) {
  const { t } = useLocale();
  const crop = useAdminMutation<
    ProductAutoCropMediaData,
    { productId: string; aspectRatio: ImageAspectRatio }
  >(ProductAutoCropMediaMutation);
  const [aspect, setAspect] = useState<ImageAspectRatio>('SQUARE');
  const [result, setResult] = useState<{ cropped: number; busy: number; blank: number } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);

  const onCrop = async () => {
    setProblem(null);
    setResult(null);
    try {
      const { productAutoCropMedia } = await crop.mutateAsync({ productId, aspectRatio: aspect });
      const error = productAutoCropMedia.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      const skipped = productAutoCropMedia.skipped ?? [];
      setResult({
        cropped: productAutoCropMedia.croppedMediaIds?.length ?? 0,
        busy: skipped.filter((skip) => skip.reason === 'BUSY_BACKGROUND').length,
        blank: skipped.filter((skip) => skip.reason === 'NO_SUBJECT').length,
      });
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <SelectField<ImageAspectRatio>
          label={t('autoCrop.shape')}
          value={aspect}
          options={[
            { value: 'SQUARE', label: t('autoCrop.square') },
            { value: 'PORTRAIT_4_5', label: t('autoCrop.portrait45') },
            { value: 'PORTRAIT_3_4', label: t('autoCrop.portrait34') },
            { value: 'LANDSCAPE_4_3', label: t('autoCrop.landscape43') },
          ]}
          onChange={setAspect}
        />
        <Button
          variant="secondary"
          busy={crop.isPending}
          icon={<Crop aria-hidden className="size-5" />}
          onClick={() => void onCrop()}
        >
          {t('autoCrop.run')}
        </Button>
      </div>
      <p className="text-sm text-secondary">{t('autoCrop.hint')}</p>
      {result && (
        <Alert tone={result.cropped > 0 ? 'success' : 'info'}>
          <p>{t('autoCrop.cropped', { count: result.cropped })}</p>
          {result.busy > 0 && <p>{t('autoCrop.busy', { count: result.busy })}</p>}
          {result.blank > 0 && <p>{t('autoCrop.blank', { count: result.blank })}</p>}
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}
