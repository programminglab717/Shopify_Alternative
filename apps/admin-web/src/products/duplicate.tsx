/** A product duplicated as a draft to change, for the next print of a suit (CAT-01, ADR-343). */
import { useNavigate } from '@tanstack/react-router';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ProductDuplicateMutation } from '../api/operations';
import type { ProductDuplicateData } from '../api/types';
import { useLocale } from '../i18n/locale';
import { useAttempt } from '../returns/parcel';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';
import { TextField } from '../ui/field';

interface Duplicated {
  id: string;
  title: string;
  media: readonly unknown[];
}

/**
 * Duplicates a product, for those who change products: the copy titled as staff write it, its
 * photos and videos with it if they ask, made as a draft, hidden until shown, its stock none and
 * its SKUs left to give; its page opened once made.
 */
export function DuplicateProduct({ product }: { product: Duplicated }) {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const duplicate = useAdminMutation<
    ProductDuplicateData,
    { productId: string; newTitle: string; newStatus: 'DRAFT'; includeImages: boolean }
  >(ProductDuplicateMutation);
  const { problem, attempt } = useAttempt();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [photos, setPhotos] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    let copy: string | null = null;
    const ok = await attempt(async () => {
      const { productDuplicate } = await duplicate.mutateAsync({
        productId: product.id,
        newTitle: title.trim(),
        newStatus: 'DRAFT',
        includeImages: photos,
      });
      copy = productDuplicate.newProduct?.id ?? null;
      return productDuplicate;
    });
    if (ok && copy) {
      setOpen(false);
      void navigate({
        to: '/$shopId/products/$productId',
        params: { shopId: shop.id, productId: copy },
        search: { added: 'copy' },
      });
    }
  };

  if (!open) {
    return (
      <Button
        variant="secondary"
        icon={<Copy aria-hidden className="size-5" />}
        onClick={() => {
          setTitle(t('duplicate.copyOf', { title: product.title }));
          setPhotos(false);
          setOpen(true);
        }}
        className="ms-auto shrink-0"
      >
        {t('duplicate.open')}
      </Button>
    );
  }

  return (
    <Card className="basis-full p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <h2 className="font-semibold" dir="auto">
          {t('duplicate.heading', { title: product.title })}
        </h2>
        <TextField
          label={t('duplicate.title')}
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        {product.media.length > 0 && (
          <CheckField label={t('duplicate.photos')} checked={photos} onChange={setPhotos} />
        )}
        <p className="text-secondary">{t('duplicate.note')}</p>
        {problem && <Alert tone="danger">{problem}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            busy={duplicate.isPending}
            disabled={!title.trim()}
            icon={<Copy aria-hidden className="size-5" />}
          >
            {t('duplicate.submit')}
          </Button>
          <Button variant="tertiary" onClick={() => setOpen(false)}>
            {t('returns.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
