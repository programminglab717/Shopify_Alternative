import { browserFetch } from '../api/client';
import { FileCreateMutation, StagedUploadsCreateMutation } from '../api/operations';
import type { StagedUploadsCreateData, UserError } from '../api/types';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { preparePhoto } from '../products/photos';
import { useAdminMutation } from './shop-context';

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * A photo from the phone made a file of the shop's (ADR-079): made smaller in the browser where
 * it is large, put straight to storage through a signed URL, then made a file. Answers the file's
 * ID, or what went wrong in the merchant's words.
 */
export function useImageUpload() {
  const { t } = useLocale();
  const stage = useAdminMutation<StagedUploadsCreateData, { input: Record<string, string>[] }>(
    StagedUploadsCreateMutation,
  );
  const create = useAdminMutation<
    { fileCreate: { files: { id: string }[] | null; userErrors: UserError[] } },
    { files: { originalSource: string; alt: string }[] }
  >(FileCreateMutation);

  return async (file: File, alt: string): Promise<{ id: string } | { problem: string }> => {
    const photo = await preparePhoto(file);
    if (!photo) return { problem: t('photos.badType', { name: file.name }) };
    if (photo.size > MAX_BYTES) return { problem: t('photos.tooBig', { name: file.name }) };
    const { stagedUploadsCreate } = await stage.mutateAsync({
      input: [{ filename: photo.name, mimeType: photo.type, fileSize: String(photo.size) }],
    });
    const target = stagedUploadsCreate.stagedTargets?.[0];
    if (!target) {
      const error = stagedUploadsCreate.userErrors[0];
      return { problem: error ? problemText(error, t) : t('state.error') };
    }
    const response = await browserFetch(target.url, {
      method: target.httpMethod,
      headers: Object.fromEntries(target.parameters.map((each) => [each.name, each.value])),
      body: photo,
    });
    if (!response.ok) return { problem: t('photos.uploadFailed', { name: photo.name }) };
    const { fileCreate } = await create.mutateAsync({
      files: [{ originalSource: target.resourceUrl, alt }],
    });
    const made = fileCreate.files?.[0];
    if (made) return { id: made.id };
    const error = fileCreate.userErrors[0];
    return { problem: error ? problemText(error, t) : t('state.error') };
  };
}
