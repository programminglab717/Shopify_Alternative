import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Camera } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  ProductAutoCropMediaMutation,
  ProductCopyDraftMutation,
  ProductCopyDraftingQuery,
  ProductCreateMutation,
  ProductQuery,
  ProductUpdateMutation,
} from '../api/operations';
import type {
  ProductCopyDraftData,
  ProductCopyDraftingData,
  ProductCreateData,
  ProductData,
  ProductUpdateData,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, EmptyState } from '../ui/feedback';
import { TextField } from '../ui/field';
import { plainTextOf } from './copy-draft';
import { usePhotoUpload } from './photos';
import { FormSection, parsePrice, problemText, TextArea } from './product-form';
import { EDITS_PRODUCTS } from './status';

/** How long the photos are waited for, to be ready for the AI, and how often they are asked after. */
export const SNAP_WAIT = { totalMs: 90_000, everyMs: 2_000 } as const;

type Step = 'creating' | 'uploading' | 'waiting' | 'cropping' | 'drafting' | 'saving';

const STEPS: Record<Step, MessageKey> = {
  creating: 'snap.creating',
  uploading: 'snap.uploading',
  waiting: 'snap.waiting',
  cropping: 'snap.cropping',
  drafting: 'snap.drafting',
  saving: 'snap.saving',
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A product added from a photo (APP-02, ADR-507): the merchant takes a photo, or chooses some,
 * and gives a price if they like. Hatti adds the product as a draft with the photos, squares
 * them to the product, and has the AI write its title, description and search engine words from
 * what the photos show and what the merchant says; then opens it, for the merchant to check and
 * put on sale. Without AI, the product is added with its photos for the merchant to name.
 */
export function SnapProductPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const store = useSessionStore();
  const navigate = useNavigate();
  const camera = useRef<HTMLInputElement>(null);
  const drafting = useAdminQuery<ProductCopyDraftingData>(
    ['productCopyDrafting'],
    ProductCopyDraftingQuery,
  );
  const create = useAdminMutation<ProductCreateData, { input: Record<string, unknown> }>(
    ProductCreateMutation,
  );
  const crop = useAdminMutation<unknown, { productId: string; aspectRatio: 'SQUARE' }>(
    ProductAutoCropMediaMutation,
  );
  const draft = useAdminMutation<ProductCopyDraftData, { input: Record<string, unknown> }>(
    ProductCopyDraftMutation,
  );
  const update = useAdminMutation<ProductUpdateData, { input: Record<string, unknown> }>(
    ProductUpdateMutation,
  );
  const putUp = usePhotoUpload();
  const [photos, setPhotos] = useState<File[]>([]);
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [step, setStep] = useState<Step | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  if (!permits(shop, EDITS_PRODUCTS)) return <EmptyState title={t('product.cannotEdit')} />;
  const ai = drafting.data?.productCopyDrafting;
  const aiReady = Boolean(ai?.available && ai.usedToday < ai.limitPerDay && ai.creditsLeft !== 0);

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = '';
    if (chosen.length > 0) setPhotos((current) => [...current, ...chosen].slice(0, 10));
  };

  /** Whether one of the product's photos is ready, asked after until one is or none can be. */
  const photoReady = async (productId: string): Promise<boolean> => {
    const until = Date.now() + SNAP_WAIT.totalMs;
    for (;;) {
      const { product } = await store.graphql<ProductData>(shop.id, ProductQuery, {
        id: productId,
      });
      const images = (product?.media ?? []).filter((each) => each.mediaContentType === 'IMAGE');
      if (images.some((each) => each.status === 'READY')) return true;
      if (images.every((each) => each.status === 'FAILED') || Date.now() >= until) return false;
      await wait(SNAP_WAIT.everyMs);
    }
  };

  const onDraft = async () => {
    setProblems([]);
    const amount = price.trim() ? parsePrice(price) : null;
    if (price.trim() && amount === null) {
      setProblems([t('product.needsPrice')]);
      return;
    }
    const said: string[] = [];
    let productId: string | null = null;
    try {
      setStep('creating');
      const { productCreate } = await create.mutateAsync({
        input: {
          title: t('snap.untitled'),
          status: 'DRAFT',
          ...(amount !== null && { variants: [{ price: amount }] }),
        },
      });
      if (!productCreate.product) {
        setProblems(productCreate.userErrors.map((error) => problemText(error, t)));
        return;
      }
      productId = productCreate.product.id;

      setStep('uploading');
      said.push(...(await putUp(productId, photos, t('snap.untitled'))));

      setStep('waiting');
      if (await photoReady(productId)) {
        setStep('cropping');
        await crop.mutateAsync({ productId, aspectRatio: 'SQUARE' }).catch(() => null);
        if (aiReady) {
          setStep('drafting');
          const { productCopyDraft } = await draft.mutateAsync({
            input: {
              language: locale === 'ur' ? 'URDU' : 'ENGLISH',
              productId,
              usePhotos: true,
              notes: notes.trim() || null,
            },
          });
          const copy = productCopyDraft.draft;
          if (copy) {
            setStep('saving');
            const { productUpdate } = await update.mutateAsync({
              input: {
                id: productId,
                title: copy.title,
                description: plainTextOf(copy.descriptionHtml),
                seo: { title: copy.seoTitle, description: copy.seoDescription },
              },
            });
            said.push(...productUpdate.userErrors.map((error) => problemText(error, t)));
          } else {
            said.push(productCopyDraft.userErrors[0]?.message ?? t('snap.noDraft'));
          }
        }
      } else {
        said.push(t('snap.notReady'));
      }
    } catch (failure) {
      said.push(errorText(failure, t));
    } finally {
      setStep(null);
    }
    if (!productId) {
      setProblems(said);
      return;
    }
    void navigate({
      to: '/$shopId/products/$productId',
      params: { shopId: shop.id, productId },
      search: { added: said.length === 0 ? 'photo' : 'photoPartly' },
      replace: true,
    });
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 pb-8">
      <div className="flex items-center gap-2">
        <Link
          to="/$shopId/products"
          params={{ shopId: shop.id }}
          aria-label={t('products.title')}
          className="inline-flex size-12 items-center justify-center rounded-control hover:bg-canvas md:size-10"
        >
          <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        </Link>
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('snap.title')}
        </h1>
      </div>
      <FormSection title={t('snap.photos')} hint={t(aiReady ? 'snap.hint' : 'snap.hintNoAi')}>
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
          aria-label={t('snap.take')}
          onChange={onChosen}
        />
        <Button
          variant="secondary"
          icon={<Camera aria-hidden className="size-5" />}
          disabled={step !== null}
          onClick={() => camera.current?.click()}
        >
          {t(photos.length === 0 ? 'snap.take' : 'snap.takeAnother')}
        </Button>
        {photos.length > 0 && (
          <ul className="flex flex-col gap-1 text-secondary">
            {photos.map((photo, index) => (
              <li key={`${photo.name}-${index}`} dir="auto">
                {photo.name}
              </li>
            ))}
          </ul>
        )}
        <TextField
          label={t('snap.price')}
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          inputMode="decimal"
          ltr
        />
        {aiReady && <TextArea label={t('snap.notes')} value={notes} onChange={setNotes} />}
      </FormSection>
      {step && (
        <Alert tone="info">
          <span role="status">{t(STEPS[step])}</span>
        </Alert>
      )}
      {problems.length > 0 && (
        <Alert tone="danger">
          {problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
        </Alert>
      )}
      <Button
        busy={step !== null}
        disabled={photos.length === 0 || step !== null}
        onClick={() => void onDraft()}
      >
        {t(aiReady ? 'snap.draft' : 'snap.add')}
      </Button>
    </div>
  );
}
