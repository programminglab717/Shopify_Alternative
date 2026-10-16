import { FileUp, ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { browserFetch } from '../api/client';
import {
  ShopVerificationQuery,
  ShopVerificationSubmitMutation,
  StagedUploadsCreateMutation,
} from '../api/operations';
import type {
  ShopVerificationData,
  ShopVerificationSubmitData,
  StagedUploadsCreateData,
  VerificationLevel,
  VerificationRequest,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToSettings } from './settings-page';

/** What a document may be, and weigh, as the API takes it (ADR-465). */
const DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const DOCUMENT_BYTES = 10 * 1024 * 1024;
const MOST_DOCUMENTS = 3;

const LEVEL_LABELS: Record<VerificationLevel, MessageKey> = {
  IDENTITY: 'verification.levelIdentity',
  BUSINESS: 'verification.levelBusiness',
};

/** The owner's request for the next level: who runs the shop first, then the business. */
function AskForm({ level, onSent }: { level: VerificationLevel; onSent: () => Promise<unknown> }) {
  const { t } = useLocale();
  const filesId = useId();
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const stage = useAdminMutation<StagedUploadsCreateData, { input: Record<string, string>[] }>(
    StagedUploadsCreateMutation,
  );
  const submit = useAdminMutation<ShopVerificationSubmitData, { input: Record<string, unknown> }>(
    ShopVerificationSubmitMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const identity = level === 'IDENTITY';

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = '';
    const found = [
      ...(chosen.length > MOST_DOCUMENTS ? [t('verification.tooMany')] : []),
      ...chosen
        .filter((file) => !DOCUMENT_TYPES.includes(file.type))
        .map((file) => t('verification.documentType', { name: file.name })),
      ...chosen
        .filter((file) => file.size > DOCUMENT_BYTES)
        .map((file) => t('verification.documentSize', { name: file.name })),
    ];
    setProblems(found);
    setFiles(found.length > 0 ? [] : chosen);
  };

  /** A document staged and put to storage: its resourceUrl for the request. */
  const uploaded = async (file: File): Promise<string> => {
    const { stagedUploadsCreate } = await stage.mutateAsync({
      input: [{ filename: file.name, mimeType: file.type, fileSize: String(file.size) }],
    });
    const target = stagedUploadsCreate.stagedTargets?.[0];
    if (!target) {
      const error = stagedUploadsCreate.userErrors[0];
      throw new Error(error ? problemText(error, t) : t('state.error'));
    }
    const response = await browserFetch(target.url, {
      method: target.httpMethod,
      headers: Object.fromEntries(target.parameters.map((each) => [each.name, each.value])),
      body: file,
    });
    if (!response.ok) throw new Error(t('photos.uploadFailed', { name: file.name }));
    return target.resourceUrl;
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || files.length === 0) return;
    setBusy(true);
    setProblems([]);
    let documents: string[];
    try {
      documents = [];
      for (const file of files) documents.push(await uploaded(file));
    } catch (failure) {
      setProblems([errorText(failure, t)]);
      setBusy(false);
      return;
    }
    // Uploaded once; only the request waits on the owner proving who they are.
    await run(
      async () => {
        const { shopVerificationSubmit } = await submit.mutateAsync({
          input: {
            level,
            name,
            documents,
            ...(identity ? { cnic: number } : { ntn: number }),
          },
        });
        setBusy(false);
        if (shopVerificationSubmit.userErrors.length > 0) {
          setProblems(shopVerificationSubmit.userErrors.map((each) => problemText(each, t)));
        } else {
          // Read again: the request waiting takes the form's place.
          await onSent();
        }
      },
      (failure) => {
        setProblems([errorText(failure, t)]);
        setBusy(false);
      },
    );
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">
            {t(identity ? 'verification.askIdentity' : 'verification.askBusiness')}
          </h2>
          <p className="text-secondary">
            {t(identity ? 'verification.askIdentityHint' : 'verification.askBusinessHint')}
          </p>
        </div>
        <TextField
          label={t(identity ? 'verification.name' : 'verification.businessName')}
          value={name}
          maxLength={100}
          required
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label={t(identity ? 'verification.cnic' : 'verification.ntn')}
          value={number}
          ltr
          inputMode="numeric"
          placeholder={identity ? '35202-1234567-1' : '1234567-8'}
          required
          onChange={(event) => setNumber(event.target.value)}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={filesId} className="font-medium">
            {t('verification.documents')}
          </label>
          <input
            id={filesId}
            type="file"
            multiple
            accept={DOCUMENT_TYPES.join(',')}
            onChange={onChosen}
          />
          <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('verification.documentsHint')}
          </p>
          {files.length > 0 && (
            <ul className="text-secondary">
              {files.map((file) => (
                <li key={file.name} dir="auto">
                  {file.name}
                </li>
              ))}
            </ul>
          )}
        </div>
        {problems.length > 0 && (
          <Alert tone="danger">
            <ul className="flex flex-col gap-1">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
        <Button
          type="submit"
          className="self-start"
          busy={busy}
          disabled={files.length === 0}
          icon={<FileUp aria-hidden className="size-5" />}
        >
          {t('verification.send')}
        </Button>
        {panel}
      </form>
    </Card>
  );
}

/** A request on one line: what, when, and what came of it. */
function RequestRow({ request, timezone }: { request: VerificationRequest; timezone: string }) {
  const { t, locale } = useLocale();
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <span className="font-medium">
        {t('verification.request', {
          level: t(LEVEL_LABELS[request.level]),
          date: formatDate(request.createdAt, timezone, locale),
        })}
      </span>
      <span className="text-secondary" dir="auto">
        {[
          t(`verification.status.${request.status}` as MessageKey),
          request.name,
          request.cnicLast4
            ? `CNIC …${request.cnicLast4}`
            : request.ntn
              ? `NTN ${request.ntn}`
              : '',
          request.answer ?? '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </li>
  );
}

/**
 * The shop verified by Hatti (ONB-11, ADR-467): what is verified, the request waiting or the
 * last one's answer, and the owner's form for the next level. Managers see it as it is.
 */
export function VerificationPage() {
  const { t, locale } = useLocale();
  const { role } = useShop();
  const timezone = useShopTimezone();
  const query = useAdminQuery<ShopVerificationData>(['shopVerification'], ShopVerificationQuery);

  let body;
  if (query.isPending) body = <Loading label={t('state.loading')} />;
  else if (query.isError) {
    body = (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else {
    const { level, requests } = query.data.shopVerification;
    const waiting = requests.find((request) => request.status === 'WAITING');
    const [latest] = requests;
    const next: VerificationLevel | null =
      level === null ? 'IDENTITY' : level === 'IDENTITY' ? 'BUSINESS' : null;
    body = (
      <>
        <Card className="flex flex-col gap-3 p-4">
          <p className="flex items-center gap-2 font-semibold">
            <ShieldCheck
              aria-hidden
              className={`size-6 ${level ? 'text-success' : 'text-secondary'}`}
            />
            {t(
              level === 'BUSINESS'
                ? 'verification.business'
                : level === 'IDENTITY'
                  ? 'verification.identity'
                  : 'verification.none',
            )}
          </p>
          <p className="text-secondary">{t('verification.intro')}</p>
          {waiting ? (
            <Alert tone="info">
              {t('verification.waiting', {
                date: formatDate(waiting.createdAt, timezone, locale),
              })}
            </Alert>
          ) : (
            latest &&
            (latest.status === 'REFUSED' || latest.status === 'REVOKED') && (
              <Alert tone="warning">
                {t(latest.status === 'REFUSED' ? 'verification.refused' : 'verification.revoked', {
                  answer: latest.answer ?? '',
                })}
              </Alert>
            )
          )}
        </Card>
        {!waiting &&
          next &&
          (role === 'owner' ? (
            <AskForm key={next} level={next} onSent={() => query.refetch()} />
          ) : (
            <Card className="p-4">
              <p className="text-secondary">{t('verification.ownerOnly')}</p>
            </Card>
          ))}
        {requests.length > 0 && (
          <section aria-labelledby="verification-requests" className="flex flex-col gap-2">
            <h2 id="verification-requests" className="font-semibold">
              {t('verification.history')}
            </h2>
            <Card>
              <ul className="divide-y divide-line">
                {requests.map((request) => (
                  <RequestRow key={request.id} request={request} timezone={timezone} />
                ))}
              </ul>
            </Card>
          </section>
        )}
      </>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.verification')}
      </h1>
      {body}
    </div>
  );
}
