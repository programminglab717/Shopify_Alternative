import { ArrowRight, Download, FileUp, Plus, Search, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  UrlRedirectCreateMutation,
  UrlRedirectDeleteMutation,
  UrlRedirectsExportQuery,
  UrlRedirectsImportMutation,
  UrlRedirectsQuery,
} from '../api/operations';
import type {
  ContentMutationData,
  UrlRedirectsData,
  UrlRedirectsExportData,
  UrlRedirectsImportData,
  UrlRedirectValue,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { useSessionStore } from '../auth/context';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** A redirect, deleted after asking. */
function RedirectRow({ redirect }: { redirect: UrlRedirectValue }) {
  const { t } = useLocale();
  const remove = useAdminMutation<ContentMutationData, { id: string }>(UrlRedirectDeleteMutation);
  const { problem, attempt } = useAttempt();
  const [asking, setAsking] = useState(false);
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2" dir="ltr">
          <span className="break-all">{redirect.path}</span>
          <ArrowRight aria-hidden className="size-4 shrink-0 text-secondary" />
          <span className="break-all text-secondary">{redirect.target}</span>
        </span>
        {!asking && (
          <Button
            variant="tertiary"
            aria-label={t('redirects.deleteOne', { path: redirect.path })}
            icon={<Trash2 aria-hidden className="size-5" />}
            onClick={() => setAsking(true)}
          />
        )}
      </div>
      {asking && (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t('redirects.deleteAsk', { path: redirect.path })}</span>
          <Button
            variant="destructive"
            busy={remove.isPending}
            onClick={() =>
              void attempt(
                async () => Object.values(await remove.mutateAsync({ id: redirect.id }))[0]!,
              )
            }
          >
            {t('redirects.deleteConfirm')}
          </Button>
          <Button variant="tertiary" onClick={() => setAsking(false)}>
            {t('returns.cancel')}
          </Button>
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/** A redirect added: an old address, and where it now goes. */
function AddRedirect() {
  const { t } = useLocale();
  const create = useAdminMutation<
    ContentMutationData,
    { urlRedirect: { path: string; target: string } }
  >(UrlRedirectCreateMutation);
  const { problem, attempt } = useAttempt();
  const [path, setPath] = useState('');
  const [target, setTarget] = useState('');
  const [added, setAdded] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim() || !target.trim()) return;
    setAdded(null);
    const ok = await attempt(
      async () =>
        Object.values(
          await create.mutateAsync({ urlRedirect: { path: path.trim(), target: target.trim() } }),
        )[0]!,
    );
    if (ok) {
      setAdded(path.trim());
      setPath('');
      setTarget('');
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <FormSection title={t('redirects.add')} hint={t('redirects.addHint')}>
        <TextField
          label={t('redirects.path')}
          hint={t('redirects.pathHint')}
          ltr
          placeholder="/products/old-name"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <TextField
          label={t('redirects.target')}
          hint={t('redirects.targetHint')}
          ltr
          placeholder="/products/new-name"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {added && <Alert tone="success">{t('redirects.added', { path: added })}</Alert>}
        <Button
          type="submit"
          className="self-start"
          icon={<Plus aria-hidden className="size-5" />}
          busy={create.isPending}
          disabled={!path.trim() || !target.trim()}
        >
          {t('redirects.addButton')}
        </Button>
      </FormSection>
    </form>
  );
}

type Checked = UrlRedirectsImportData['urlRedirectsImport'];

/**
 * Redirects from Shopify's CSV (ONB-05): the file checked first, saying what it would add, skip
 * and could not read; then added when the merchant says so.
 */
function ImportRedirects() {
  const { t } = useLocale();
  const run = useAdminMutation<UrlRedirectsImportData, { csv: string; dryRun: boolean }>(
    UrlRedirectsImportMutation,
  );
  const { problem, attempt } = useAttempt();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [done, setDone] = useState<Checked | null>(null);

  const check = async (csv: string, dryRun: boolean) => {
    const answer: { value?: Checked } = {};
    const ok = await attempt(async () => {
      answer.value = (await run.mutateAsync({ csv, dryRun })).urlRedirectsImport;
      return answer.value;
    });
    return ok ? answer.value! : null;
  };

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    setDone(null);
    setChecked(null);
    void chosen.text().then(async (csv) => {
      setFile({ name: chosen.name, csv });
      setChecked(await check(csv, true));
    });
  };

  return (
    <FormSection title={t('redirects.import')} hint={t('redirects.importHint')}>
      <Button
        variant="secondary"
        className="self-start"
        icon={<FileUp aria-hidden className="size-5" />}
        busy={run.isPending && !checked}
        onClick={() => input.current?.click()}
      >
        {t('redirects.importChoose')}
      </Button>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        aria-label={t('redirects.importFile')}
        onChange={onChosen}
      />
      {file && checked && !done && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <p>
            {t('redirects.checked', {
              name: file.name,
              rows: checked.rows,
              created: checked.created,
              skipped: checked.skipped,
            })}
          </p>
          {checked.rowErrorCount > 0 && (
            <Alert tone="warning">
              <span className="flex flex-col gap-1">
                <span>{t('redirects.rowErrors', { count: checked.rowErrorCount })}</span>
                {checked.rowErrors.slice(0, 5).map((error) => (
                  <span key={`${error.row}-${error.column ?? ''}`}>
                    {t('redirects.rowError', { row: error.row, message: error.message })}
                  </span>
                ))}
              </span>
            </Alert>
          )}
          {checked.created > 0 && (
            <Button
              className="self-start"
              busy={run.isPending}
              onClick={() =>
                void check(file.csv, false).then((result) => {
                  if (result) {
                    setDone(result);
                    setChecked(null);
                  }
                })
              }
            >
              {t('redirects.importConfirm', { count: checked.created })}
            </Button>
          )}
        </div>
      )}
      {done && (
        <Alert tone="success">
          {t('redirects.imported', { created: done.created, skipped: done.skipped })}
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/** The shop's redirects as Shopify's CSV, saved on the phone. */
function ExportRedirects() {
  const { t } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { urlRedirectsExport } = await store.graphql<UrlRedirectsExportData>(
        shop.id,
        UrlRedirectsExportQuery,
      );
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([urlRedirectsExport.csv], { type: 'text/csv' }));
      link.download = 'redirects.csv';
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="tertiary"
        className="self-start"
        icon={<Download aria-hidden className="size-5" />}
        busy={busy}
        onClick={() => void download()}
      >
        {t('redirects.export')}
      </Button>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/**
 * The shop's redirects (OS-09), for owners and managers: old addresses, such as a Shopify
 * store's, sent on to where their pages are now; found, added, deleted, imported from Shopify's
 * CSV and exported to it.
 */
export function RedirectsTab() {
  const { t } = useLocale();
  const [search, setSearch] = useState('');
  const query = useAdminQuery<UrlRedirectsData>(['url-redirects', search], UrlRedirectsQuery, {
    query: search.trim() || null,
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-secondary">{t('redirects.intro')}</p>
      <label className="flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-3 md:min-h-10">
        <Search aria-hidden className="size-5 text-secondary" />
        <span className="sr-only">{t('redirects.search')}</span>
        <input
          type="search"
          dir="ltr"
          placeholder={t('redirects.search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-0 flex-1 bg-transparent outline-none"
        />
      </label>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.urlRedirects.nodes.length === 0 ? (
        <Card>
          <EmptyState title={t(search.trim() ? 'redirects.noneFound' : 'redirects.none')} />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line" aria-label={t('redirects.list')}>
            {query.data.urlRedirects.nodes.map((redirect) => (
              <RedirectRow key={redirect.id} redirect={redirect} />
            ))}
          </ul>
          {query.data.urlRedirects.pageInfo.hasNextPage && (
            <p className="px-4 py-2 text-secondary">{t('redirects.more')}</p>
          )}
        </Card>
      )}
      <ExportRedirects />
      <AddRedirect />
      <ImportRedirects />
    </div>
  );
}
