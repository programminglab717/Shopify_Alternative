import { Camera, ImageOff, LoaderCircle, Star, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  ProductCreateMediaMutation,
  ProductDeleteMediaMutation,
  ProductReorderMediaMutation,
  StagedUploadsCreateMutation,
} from '../api/operations';
import { browserFetch } from '../api/client';
import type {
  ProductCreateMediaData,
  ProductDeleteMediaData,
  ProductDetail,
  ProductMedia,
  ProductReorderMediaData,
  StagedUploadsCreateData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { FormSection, problemText } from './product-form';

/** The types the core takes for an image (ADR-079). */
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
/** Photos at most this long a side go up as they are; larger, they are made this size first. */
const LONGEST_SIDE = 2048;
/** A photo smaller than this goes up as it is, whatever its size in pixels. */
const SMALL_BYTES = 1_500_000;
const MAX_BYTES = 20 * 1024 * 1024;
/** Files staged in one call. */
const BATCH = 10;

/**
 * A photo as it should go up: a phone's large photo made at most 2,048 pixels a side, which the
 * storefront shows no larger, so it costs the merchant's data a fraction; one in a format the
 * core does not take (a phone's HEIC) made a JPEG where the browser can read it. Null when it
 * can be neither sent nor read.
 */
export async function preparePhoto(file: File): Promise<File | null> {
  const accepted = TYPES.includes(file.type);
  if (accepted && (file.type === 'image/gif' || file.size <= SMALL_BYTES)) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return accepted ? file : null;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height));
    if (accepted && scale === 1) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const type = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
    if (!blob) return accepted ? file : null;
    const name = type === 'image/jpeg' ? file.name.replace(/\.[^.]*$/, '') + '.jpg' : file.name;
    return new File([blob], name, { type });
  } catch {
    return accepted ? file : null;
  }
}

function MediaTile({
  media,
  first,
  edits,
  busy,
  onRemove,
  onMakeFirst,
}: {
  media: ProductMedia;
  first: boolean;
  edits: boolean;
  busy: boolean;
  onRemove: () => void;
  onMakeFirst: () => void;
}) {
  const { t } = useLocale();
  const [removing, setRemoving] = useState(false);
  const url = media.previewImage?.url;
  const at = (width: number) => `${url}${url?.includes('?') ? '&' : '?'}width=${width}`;
  return (
    <li className="flex flex-col gap-2">
      <div className="relative aspect-square overflow-hidden rounded-control border border-line bg-canvas">
        {media.status === 'READY' && url ? (
          <img
            src={at(360)}
            srcSet={`${at(192)} 192w, ${at(360)} 360w, ${at(540)} 540w`}
            sizes="(min-width: 768px) 160px, 45vw"
            alt={media.alt}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : media.status === 'FAILED' ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center text-danger text-[length:var(--hatti-type-body-sm-size)]">
            <ImageOff aria-hidden className="size-6" />
            {media.mediaErrors[0]?.message ?? t('photos.failed')}
          </div>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-1 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            <LoaderCircle aria-hidden className="size-6 animate-spin" />
            {t('photos.processing')}
          </div>
        )}
        {first && media.status === 'READY' && (
          <span className="absolute start-1 top-1 rounded-full bg-surface px-2 text-[length:var(--hatti-type-caption-size)] font-medium">
            {t('photos.main')}
          </span>
        )}
      </div>
      {edits && (
        <div className="flex gap-1">
          {removing ? (
            <>
              <Button
                variant="destructive"
                className="flex-1 px-2"
                disabled={busy}
                onClick={onRemove}
              >
                {t('photos.removeYes')}
              </Button>
              <Button variant="tertiary" className="px-2" onClick={() => setRemoving(false)}>
                {t('action.back')}
              </Button>
            </>
          ) : (
            <>
              {!first && (
                <Button
                  variant="tertiary"
                  className="flex-1 px-2"
                  aria-label={t('photos.makeMain')}
                  icon={<Star aria-hidden className="size-5" />}
                  disabled={busy}
                  onClick={onMakeFirst}
                />
              )}
              <Button
                variant="tertiary"
                className="flex-1 px-2 text-danger"
                aria-label={t('photos.remove')}
                icon={<Trash2 aria-hidden className="size-5" />}
                disabled={busy}
                onClick={() => setRemoving(true)}
              />
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * A product's photos (CAT-02, ADR-158): taken with the phone's camera or chosen from its gallery,
 * uploaded straight to storage, and shown as the core makes each ready, or says why it could not;
 * the first is the one listings show.
 */
export function ProductPhotos({ product, edits }: { product: ProductDetail; edits: boolean }) {
  const { t } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const stage = useAdminMutation<StagedUploadsCreateData, { input: Record<string, string>[] }>(
    StagedUploadsCreateMutation,
  );
  const create = useAdminMutation<
    ProductCreateMediaData,
    { productId: string; media: Record<string, string>[] }
  >(ProductCreateMediaMutation);
  const remove = useAdminMutation<
    ProductDeleteMediaData,
    { productId: string; mediaIds: string[] }
  >(ProductDeleteMediaMutation);
  const reorder = useAdminMutation<
    ProductReorderMediaData,
    { productId: string; moves: { id: string; newPosition: number }[] }
  >(ProductReorderMediaMutation);
  const [uploading, setUploading] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);
  const busy = uploading > 0 || remove.isPending || reorder.isPending;
  const images = product.media.filter((each) => each.mediaContentType === 'IMAGE');

  const upload = async (chosen: File[]) => {
    setProblems([]);
    const wrong: string[] = [];
    const ready: File[] = [];
    setUploading(chosen.length);
    try {
      for (const file of chosen) {
        const photo = await preparePhoto(file);
        if (!photo) wrong.push(t('photos.badType', { name: file.name }));
        else if (photo.size > MAX_BYTES) wrong.push(t('photos.tooBig', { name: file.name }));
        else ready.push(photo);
      }
      for (let start = 0; start < ready.length; start += BATCH) {
        const batch = ready.slice(start, start + BATCH);
        const { stagedUploadsCreate } = await stage.mutateAsync({
          input: batch.map((photo) => ({
            filename: photo.name,
            mimeType: photo.type,
            fileSize: String(photo.size),
          })),
        });
        if (stagedUploadsCreate.userErrors.length > 0 || !stagedUploadsCreate.stagedTargets) {
          wrong.push(...stagedUploadsCreate.userErrors.map((error) => problemText(error, t)));
          continue;
        }
        // In the order they were chosen, however fast each goes up.
        const sent: (string | null)[] = batch.map(() => null);
        await Promise.all(
          stagedUploadsCreate.stagedTargets.map(async (target, index) => {
            const photo = batch[index]!;
            const headers = Object.fromEntries(
              target.parameters.map((parameter) => [parameter.name, parameter.value]),
            );
            const response = await browserFetch(target.url, {
              method: target.httpMethod,
              headers,
              body: photo,
            });
            if (response.ok) sent[index] = target.resourceUrl;
            else wrong.push(t('photos.uploadFailed', { name: photo.name }));
          }),
        );
        const uploaded = sent.filter((url) => url !== null);
        if (uploaded.length === 0) continue;
        const { productCreateMedia } = await create.mutateAsync({
          productId: product.id,
          media: uploaded.map((originalSource) => ({
            originalSource,
            alt: product.title,
            mediaContentType: 'IMAGE',
          })),
        });
        wrong.push(...productCreateMedia.userErrors.map((error) => problemText(error, t)));
      }
    } catch (failure) {
      wrong.push(errorText(failure, t));
    } finally {
      setUploading(0);
      setProblems(wrong);
    }
  };

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = '';
    if (chosen.length > 0) void upload(chosen);
  };

  const onRemove = async (media: ProductMedia) => {
    setProblems([]);
    try {
      const { productDeleteMedia } = await remove.mutateAsync({
        productId: product.id,
        mediaIds: [media.id],
      });
      setProblems(productDeleteMedia.userErrors.map((error) => problemText(error, t)));
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const onMakeFirst = async (media: ProductMedia) => {
    setProblems([]);
    try {
      const { productReorderMedia } = await reorder.mutateAsync({
        productId: product.id,
        moves: [{ id: media.id, newPosition: 1 }],
      });
      setProblems(productReorderMedia.userErrors.map((error) => problemText(error, t)));
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  if (!edits && images.length === 0) return null;
  return (
    <FormSection title={t('photos.title')} hint={edits ? t('photos.hint') : undefined}>
      {images.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {images.map((media, index) => (
            <MediaTile
              key={media.id}
              media={media}
              first={index === 0}
              edits={edits}
              busy={busy}
              onRemove={() => void onRemove(media)}
              onMakeFirst={() => void onMakeFirst(media)}
            />
          ))}
        </ul>
      )}
      {problems.length > 0 && (
        <Alert tone="danger">
          <ul className="flex flex-col gap-1">
            {problems.map((problem, index) => (
              <li key={index}>{problem}</li>
            ))}
          </ul>
        </Alert>
      )}
      {edits && (
        <>
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            hidden
            aria-label={t('photos.add')}
            onChange={onChosen}
          />
          <Button
            variant="secondary"
            className="self-start"
            busy={uploading > 0}
            icon={<Camera aria-hidden className="size-5" />}
            onClick={() => input.current?.click()}
          >
            {uploading > 0 ? t('photos.uploading', { count: uploading }) : t('photos.add')}
          </Button>
        </>
      )}
    </FormSection>
  );
}
