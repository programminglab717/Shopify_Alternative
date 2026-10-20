import { browserFetch } from '../api/client';
import {
  FileCreateMutation,
  FileUpdateMutation,
  StagedUploadsCreateMutation,
} from '../api/operations';
import type { StagedUploadsCreateData, UserError } from '../api/types';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { preparePhoto } from '../products/photos';
import { useAdminMutation } from './shop-context';

const MAX_BYTES = 20 * 1024 * 1024;

type Uploaded = { id: string } | { problem: string };

/** A file put straight to storage through a signed URL: its resource URL, or what went wrong. */
function useStage() {
  const { t } = useLocale();
  const stage = useAdminMutation<StagedUploadsCreateData, { input: Record<string, string>[] }>(
    StagedUploadsCreateMutation,
  );
  return async (file: File): Promise<{ resourceUrl: string } | { problem: string }> => {
    if (file.size > MAX_BYTES) return { problem: t('photos.tooBig', { name: file.name }) };
    const { stagedUploadsCreate } = await stage.mutateAsync({
      input: [{ filename: file.name, mimeType: file.type, fileSize: String(file.size) }],
    });
    const target = stagedUploadsCreate.stagedTargets?.[0];
    if (!target) {
      const error = stagedUploadsCreate.userErrors[0];
      return { problem: error ? problemText(error, t) : t('state.error') };
    }
    const response = await browserFetch(target.url, {
      method: target.httpMethod,
      headers: Object.fromEntries(target.parameters.map((each) => [each.name, each.value])),
      body: file,
    });
    if (!response.ok) return { problem: t('photos.uploadFailed', { name: file.name }) };
    return { resourceUrl: target.resourceUrl };
  };
}

/** A file put straight to storage through a signed URL, then made a file of the shop's. */
function useSend() {
  const { t } = useLocale();
  const put = useStage();
  const create = useAdminMutation<
    { fileCreate: { files: { id: string }[] | null; userErrors: UserError[] } },
    { files: { originalSource: string; alt: string }[] }
  >(FileCreateMutation);

  return async (file: File, alt: string): Promise<Uploaded> => {
    const staged = await put(file);
    if ('problem' in staged) return staged;
    const { fileCreate } = await create.mutateAsync({
      files: [{ originalSource: staged.resourceUrl, alt }],
    });
    const made = fileCreate.files?.[0];
    if (made) return { id: made.id };
    const error = fileCreate.userErrors[0];
    return { problem: error ? problemText(error, t) : t('state.error') };
  };
}

/**
 * What one of the shop's files holds replaced by another picture or PDF (ADR-647), keeping its ID,
 * so wherever it is used shows the new one: a picture made smaller as {@link useImageUpload} makes
 * one. Answers the file's ID, or what went wrong in the merchant's words.
 */
export function useFileReplace() {
  const { t } = useLocale();
  const put = useStage();
  const update = useAdminMutation<
    { fileUpdate: { files: { id: string }[] | null; userErrors: UserError[] } },
    { files: { id: string; originalSource: string }[] }
  >(FileUpdateMutation);
  return async (id: string, chosen: File): Promise<Uploaded> => {
    const file = chosen.type === 'application/pdf' ? chosen : await preparePhoto(chosen);
    if (!file) return { problem: t('photos.badType', { name: chosen.name }) };
    const staged = await put(file);
    if ('problem' in staged) return staged;
    const { fileUpdate } = await update.mutateAsync({
      files: [{ id, originalSource: staged.resourceUrl }],
    });
    const replaced = fileUpdate.files?.[0];
    if (replaced) return { id: replaced.id };
    const error = fileUpdate.userErrors[0];
    return { problem: error ? problemText(error, t) : t('state.error') };
  };
}

/**
 * A photo from the phone made a file of the shop's (ADR-079): made smaller in the browser where
 * it is large, put straight to storage through a signed URL, then made a file. Answers the file's
 * ID, or what went wrong in the merchant's words.
 */
export function useImageUpload() {
  const { t } = useLocale();
  const send = useSend();
  return async (file: File, alt: string): Promise<Uploaded> => {
    const photo = await preparePhoto(file);
    if (!photo) return { problem: t('photos.badType', { name: file.name }) };
    return send(photo, alt);
  };
}

/**
 * A picture or a PDF made a file of the shop's, from its Files (ADR-636): a picture as
 * {@link useImageUpload} makes one, a PDF as it is.
 */
export function useFileUpload() {
  const image = useImageUpload();
  const send = useSend();
  return (file: File): Promise<{ id: string } | { problem: string }> =>
    file.type === 'application/pdf' ? send(file, '') : image(file, '');
}
