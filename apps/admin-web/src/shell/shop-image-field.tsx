import { ImageUp, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { FileQuery } from '../api/operations';
import type { ShopFileData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { useAdminQuery } from './shop-context';
import { useImageUpload } from './use-image-upload';

/**
 * An image of the shop's files, an article's or a collection's (ADR-785): chosen from the phone and
 * uploaded to the shop's files, shown from them, or taken away.
 */
export function ShopImageField({
  title,
  hint,
  image,
  onChange,
}: {
  title: string;
  hint: string;
  image: { fileId: string; preview?: string } | null;
  onChange: (image: { fileId: string; preview?: string } | null) => void;
}) {
  const { t } = useLocale();
  const upload = useImageUpload();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const file = useAdminQuery<ShopFileData>(
    ['file', image?.fileId],
    FileQuery,
    { id: image?.fileId ?? '' },
    { enabled: Boolean(image && !image.preview) },
  );
  const src = image?.preview ?? file.data?.file?.url;

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    setBusy(true);
    setProblem(null);
    void upload(chosen, title)
      .then((made) => {
        if ('problem' in made) setProblem(made.problem);
        else onChange({ fileId: made.id, preview: URL.createObjectURL(chosen) });
      })
      .catch((failure: unknown) => setProblem(errorText(failure, t)))
      .finally(() => setBusy(false));
  };

  return (
    <FormSection title={title} hint={hint}>
      {image && src && (
        <img
          src={src}
          alt={title}
          className="max-h-48 self-start rounded-control border border-line object-contain"
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={<ImageUp aria-hidden className="size-5" />}
          busy={busy}
          onClick={() => input.current?.click()}
        >
          {t(image ? 'shopImage.replace' : 'shopImage.choose')}
        </Button>
        {image && (
          <Button
            variant="danger"
            icon={<Trash2 aria-hidden className="size-5" />}
            disabled={busy}
            onClick={() => onChange(null)}
          >
            {t('shopImage.remove')}
          </Button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={title}
        onChange={onChosen}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}
