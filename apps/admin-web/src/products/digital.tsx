import { Download, FileUp, KeyRound, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { browserFetch } from '../api/client';
import {
  DigitalFileCreateMutation,
  DigitalFileDeleteMutation,
  DigitalFileStageMutation,
  DigitalProductRemoveMutation,
  DigitalProductSetMutation,
  LicenceKeysAddMutation,
} from '../api/operations';
import type {
  DigitalFileCreateData,
  DigitalFileDeleteData,
  DigitalFileStageData,
  DigitalFileValue,
  DigitalProductRemoveData,
  DigitalProductSetData,
  DigitalProductValue,
  LicenceKeysAddData,
  ProductDetail,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection, problemText } from './product-form';

interface Draft {
  digital: boolean;
  downloadLimit: string;
  linkDays: string;
  licenceKeys: boolean;
}

const draftOf = (digital: DigitalProductValue | null | undefined): Draft => ({
  digital: Boolean(digital),
  downloadLimit: String(digital?.downloadLimit ?? 5),
  linkDays: String(digital?.linkDays ?? 30),
  licenceKeys: digital?.licenceKeys ?? false,
});

/** A file's size as a merchant reads it: "2.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** The keys typed, one a line, the blank lines left out. */
const keysOf = (typed: string) =>
  typed
    .split(/\r?\n/)
    .map((key) => key.trim())
    .filter(Boolean);

/**
 * A product sold as a download, licence keys or both (CAT-13, ADR-816): how often and for how
 * many days each unit's link downloads its files, whether each unit is given a key, the files it
 * sells and the keys it has left. A product made digital asks its buyer for no address and is
 * delivered on WhatsApp once paid (ADR-814, ADR-815). A gift card is no digital product.
 */
export function DigitalProductCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const id = useId();
  const set = useAdminMutation<DigitalProductSetData, Record<string, unknown>>(
    DigitalProductSetMutation,
  );
  const remove = useAdminMutation<DigitalProductRemoveData, { productId: string }>(
    DigitalProductRemoveMutation,
  );
  const stage = useAdminMutation<DigitalFileStageData, Record<string, unknown>>(
    DigitalFileStageMutation,
  );
  const create = useAdminMutation<DigitalFileCreateData, { id: string }>(DigitalFileCreateMutation);
  const drop = useAdminMutation<DigitalFileDeleteData, { id: string }>(DigitalFileDeleteMutation);
  const addKeys = useAdminMutation<LicenceKeysAddData, { productId: string; keys: string[] }>(
    LicenceKeysAddMutation,
  );
  const [digital, setDigital] = useState(product.digital ?? null);
  const [draft, setDraft] = useState(() => draftOf(product.digital));
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [typedKeys, setTypedKeys] = useState('');
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(digital));

  if (product.isGiftCard) return null;

  const begin = () => {
    setProblem(null);
    setNotice(null);
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    begin();
    try {
      if (!draft.digital) {
        await remove.mutateAsync({ productId: product.id });
        setDigital(null);
        setDraft(draftOf(null));
        setNotice(t('digital.savedOff'));
        return;
      }
      const { digitalProductSet } = await set.mutateAsync({
        productId: product.id,
        input: {
          downloadLimit: Number(draft.downloadLimit),
          linkDays: Number(draft.linkDays),
          licenceKeys: draft.licenceKeys,
        },
      });
      const error = digitalProductSet.userErrors[0];
      if (error || !digitalProductSet.digitalProduct) {
        setProblem(error ? problemText(error, t) : t('state.error'));
        return;
      }
      setDigital(digitalProductSet.digitalProduct);
      setDraft(draftOf(digitalProductSet.digitalProduct));
      setNotice(t('digital.savedOn'));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const withFiles = (files: DigitalFileValue[]) => digital && setDigital({ ...digital, files });

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !digital) return;
    begin();
    setUploading(true);
    try {
      const { digitalFileStage } = await stage.mutateAsync({
        productId: product.id,
        input: {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
        },
      });
      const staged = digitalFileStage.file;
      const upload = digitalFileStage.upload;
      if (!staged || !upload) {
        const error = digitalFileStage.userErrors[0];
        setProblem(error ? problemText(error, t) : t('state.error'));
        return;
      }
      const response = await browserFetch(upload.url, {
        method: upload.method,
        headers: Object.fromEntries(upload.headers.map((each) => [each.name, each.value])),
        body: file,
      });
      if (!response.ok) {
        setProblem(t('photos.uploadFailed', { name: file.name }));
        return;
      }
      const { digitalFileCreate } = await create.mutateAsync({ id: staged.id });
      const made = digitalFileCreate.file;
      if (!made) {
        const error = digitalFileCreate.userErrors[0];
        setProblem(error ? problemText(error, t) : t('state.error'));
        return;
      }
      withFiles([...digital.files, made]);
      setNotice(t('digital.uploaded', { name: made.filename }));
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (file: DigitalFileValue) => {
    if (!digital) return;
    begin();
    try {
      await drop.mutateAsync({ id: file.id });
      withFiles(digital.files.filter((each) => each.id !== file.id));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const onAddKeys = async (event: FormEvent) => {
    event.preventDefault();
    if (!digital) return;
    begin();
    try {
      const { licenceKeysAdd } = await addKeys.mutateAsync({
        productId: product.id,
        keys: keysOf(typedKeys),
      });
      const error = licenceKeysAdd.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      setDigital({ ...digital, keysLeft: digital.keysLeft + licenceKeysAdd.added });
      setTypedKeys('');
      setNotice(
        t('digital.keysAdded', { added: licenceKeysAdd.added, already: licenceKeysAdd.already }),
      );
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('digital.title')} hint={t('digital.hint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        <CheckField
          label={t('digital.sell')}
          checked={draft.digital}
          onChange={(on) => setDraft({ ...draft, digital: on })}
        />
        {draft.digital && (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <TextField
                label={t('digital.downloadLimit')}
                hint={t('digital.downloadLimitHint')}
                inputMode="numeric"
                ltr
                required
                value={draft.downloadLimit}
                onChange={(event) => setDraft({ ...draft, downloadLimit: event.target.value })}
              />
              <TextField
                label={t('digital.linkDays')}
                hint={t('digital.linkDaysHint')}
                inputMode="numeric"
                ltr
                required
                value={draft.linkDays}
                onChange={(event) => setDraft({ ...draft, linkDays: event.target.value })}
              />
            </div>
            <CheckField
              label={t('digital.licenceKeys')}
              checked={draft.licenceKeys}
              onChange={(on) => setDraft({ ...draft, licenceKeys: on })}
            />
          </>
        )}
        <Button
          type="submit"
          className="self-start"
          busy={set.isPending || remove.isPending}
          disabled={!changed}
          icon={<Download aria-hidden className="size-5" />}
        >
          {t('digital.save')}
        </Button>
      </form>
      {digital && (
        <div className="mt-4 flex flex-col gap-3">
          <h3 className="font-medium">{t('digital.files')}</h3>
          {digital.files.length === 0 ? (
            <p className="text-secondary">{t('digital.noFiles')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {digital.files.map((file) => (
                <li key={file.id} className="flex items-center justify-between gap-2">
                  <span dir="auto">
                    {file.filename}{' '}
                    <span className="text-secondary">
                      {file.ready ? sizeText(file.size) : t('digital.notUploaded')}
                    </span>
                  </span>
                  <Button
                    variant="danger"
                    aria-label={t('digital.deleteFile', { name: file.filename })}
                    busy={drop.isPending && drop.variables?.id === file.id}
                    icon={<Trash2 aria-hidden className="size-5" />}
                    onClick={() => void onDelete(file)}
                  >
                    {t('digital.delete')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <label
            htmlFor={`${id}-file`}
            className="inline-flex min-h-12 cursor-pointer items-center gap-2 self-start rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
          >
            <FileUp aria-hidden className="size-5" />
            {uploading ? t('digital.uploading') : t('digital.upload')}
          </label>
          <input
            id={`${id}-file`}
            type="file"
            className="sr-only"
            disabled={uploading}
            onChange={(event) => void onUpload(event)}
          />
          {digital.licenceKeys && (
            <form onSubmit={(event) => void onAddKeys(event)} className="flex flex-col gap-2">
              <h3 className="font-medium">{t('digital.keys')}</h3>
              <p className="text-secondary">
                {t('digital.keysCount', { left: digital.keysLeft, issued: digital.keysIssued })}
              </p>
              <label htmlFor={`${id}-keys`} className="font-medium">
                {t('digital.keysAdd')}
              </label>
              <textarea
                id={`${id}-keys`}
                aria-describedby={`${id}-keys-hint`}
                value={typedKeys}
                rows={4}
                dir="ltr"
                onChange={(event) => setTypedKeys(event.target.value)}
                className="rounded-control border border-line bg-surface px-3 py-2 font-mono text-text"
              />
              <span
                id={`${id}-keys-hint`}
                className="text-secondary text-[length:var(--hatti-type-body-sm-size)]"
              >
                {t('digital.keysHint')}
              </span>
              <Button
                type="submit"
                variant="secondary"
                className="self-start"
                busy={addKeys.isPending}
                disabled={keysOf(typedKeys).length === 0}
                icon={<KeyRound aria-hidden className="size-5" />}
              >
                {t('digital.keysSave')}
              </Button>
            </form>
          )}
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
    </FormSection>
  );
}
