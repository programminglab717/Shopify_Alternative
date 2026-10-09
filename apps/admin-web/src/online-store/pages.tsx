import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Clock, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  PageCreateMutation,
  PageDeleteMutation,
  PageQuery,
  PagesQuery,
  PageUpdateMutation,
} from '../api/operations';
import type { PageData, PageMutationData, PagesData, PageSummary } from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { htmlFromText, textFromHtml } from './page-body';

/** Those who write the shop's pages, which are content: marketers too (ADR-176). */
export const WRITES_PAGES: readonly StaffRole[] = ['owner', 'manager', 'marketer'];

/** Whether a page shows on the storefront now, waits for its date, or is hidden. */
function usePageState() {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  return (page: Pick<PageSummary, 'isPublished' | 'publishedAt'>) => {
    if (!page.isPublished || !page.publishedAt) {
      return { colour: 'cancelled' as const, icon: EyeOff, label: t('pages.hidden') };
    }
    if (new Date(page.publishedAt).getTime() > Date.now()) {
      return {
        colour: 'needsConfirmation' as const,
        icon: Clock,
        label: t('pages.scheduled', { date: formatDate(page.publishedAt, timezone, locale) }),
      };
    }
    return { colour: 'delivered' as const, icon: Eye, label: t('pages.shown') };
  };
}

/** The shop's pages, each with whether it shows; a new one written from here. */
export function PagesList() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const state = usePageState();
  const query = useAdminQuery<PagesData>(['pages'], PagesQuery);

  return (
    <div className="flex flex-col gap-3">
      <Link
        to="/$shopId/online-store/pages/new"
        params={{ shopId }}
        className="inline-flex min-h-12 items-center gap-2 self-start rounded-control bg-primary px-4 font-medium text-on-primary hover:bg-primary-strong md:min-h-10"
      >
        <Plus aria-hidden className="size-5" />
        {t('pages.add')}
      </Link>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.pages.nodes.length === 0 ? (
        <Card>
          <EmptyState title={t('pages.none')} />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.pages.nodes.map((page) => {
              const shown = state(page);
              return (
                <li key={page.id}>
                  <Link
                    to="/$shopId/online-store/pages/$pageId"
                    params={{ shopId, pageId: page.id }}
                    className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 hover:bg-canvas"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium" dir="auto">
                        {page.title}
                      </span>
                      <span className="text-secondary" dir="ltr">
                        /pages/{page.handle}
                      </span>
                    </span>
                    <Badge {...shown} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

function BackToPages() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  return (
    <Link
      to="/$shopId/online-store"
      params={{ shopId }}
      search={{ tab: 'pages' }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('pages.back')}
    </Link>
  );
}

/**
 * A page's title, body and whether it shows. The body is written as plain text, paragraphs a
 * blank line apart; one with more formatting than that, written elsewhere, is edited as HTML.
 */
function PageForm({ page }: { page?: NonNullable<PageData['page']> }) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const bodyId = useId();
  const create = useAdminMutation<PageMutationData, { page: Record<string, unknown> }>(
    PageCreateMutation,
  );
  const update = useAdminMutation<PageMutationData, { id: string; page: Record<string, unknown> }>(
    PageUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const plain = page ? textFromHtml(page.body) : '';
  const asHtml = plain === null;
  const [title, setTitle] = useState(page?.title ?? '');
  const [body, setBody] = useState(plain ?? page?.body ?? '');
  const [shown, setShown] = useState(page ? page.isPublished : true);
  const [saved, setSaved] = useState(false);
  const html = asHtml ? body : htmlFromText(body);
  const input = page
    ? {
        ...(title.trim() !== page.title && { title: title.trim() }),
        ...(html !== (asHtml ? page.body : htmlFromText(plain ?? '')) && { body: html }),
        ...(shown !== page.isPublished && { isPublished: shown }),
      }
    : { title: title.trim(), body: html, isPublished: shown };
  const changed = Object.keys(input).length > 0;
  const ready = title.trim() !== '' && changed;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSaved(false);
    const made: { id?: string } = {};
    const ok = await attempt(async () => {
      const payload = Object.values(
        page
          ? await update.mutateAsync({ id: page.id, page: input })
          : await create.mutateAsync({ page: input }),
      )[0]!;
      made.id = payload.page?.id;
      return payload;
    });
    if (!ok) return;
    if (page) setSaved(true);
    else if (made.id) {
      await navigate({
        to: '/$shopId/online-store/pages/$pageId',
        params: { shopId, pageId: made.id },
      });
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('pages.content')}>
        <TextField
          label={t('pages.titleLabel')}
          required
          dir="auto"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={bodyId} className="font-medium">
            {t(asHtml ? 'pages.bodyHtml' : 'pages.body')}
          </label>
          <p className="text-secondary">{t(asHtml ? 'pages.bodyHtmlHint' : 'pages.bodyHint')}</p>
          <textarea
            id={bodyId}
            value={body}
            rows={12}
            dir={asHtml ? 'ltr' : 'auto'}
            onChange={(event) => setBody(event.target.value)}
            className={`rounded-control border border-line bg-surface px-3 py-2 text-text ${
              asHtml ? 'font-mono text-[length:var(--hatti-type-body-sm-size)]' : ''
            }`}
          />
        </div>
      </FormSection>
      <FormSection title={t('pages.visibility')}>
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">{t('pages.visibility')}</legend>
          {[true, false].map((each) => (
            <label key={String(each)} className="flex min-h-10 items-center gap-2">
              <input
                type="radio"
                name="shown"
                checked={shown === each}
                onChange={() => setShown(each)}
                className="size-5 accent-[var(--hatti-color-primary)]"
              />
              {t(each ? 'pages.show' : 'pages.hide')}
            </label>
          ))}
        </fieldset>
      </FormSection>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {saved && !changed && <Alert tone="success">{t('pages.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={create.isPending || update.isPending}
        disabled={!ready}
      >
        {t(page ? 'pages.save' : 'pages.create')}
      </Button>
    </form>
  );
}

/** A new page (OS-07), for those who write the shop's content. */
export function NewPagePage() {
  const { t } = useLocale();
  const { role } = useShop();
  if (!WRITES_PAGES.includes(role)) return <EmptyState title={t('pages.cannot')} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToPages />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('pages.add')}
      </h1>
      <PageForm />
    </div>
  );
}

/** The page deleted after asking; menus linking to it leave the link out. */
function DeletePage({ page }: { page: PageSummary }) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const remove = useAdminMutation<PageMutationData, { id: string }>(PageDeleteMutation);
  const { problem, attempt } = useAttempt();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button
        variant="danger"
        className="self-start"
        icon={<Trash2 aria-hidden className="size-5" />}
        onClick={() => setAsking(true)}
      >
        {t('pages.delete')}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <p>{t('pages.deleteAsk', { title: page.title })}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          busy={remove.isPending}
          onClick={() =>
            void (async () => {
              const ok = await attempt(
                async () => Object.values(await remove.mutateAsync({ id: page.id }))[0]!,
              );
              if (ok) {
                await navigate({
                  to: '/$shopId/online-store',
                  params: { shopId },
                  search: { tab: 'pages' },
                });
              }
            })()
          }
        >
          {t('pages.deleteConfirm')}
        </Button>
        <Button variant="tertiary" onClick={() => setAsking(false)}>
          {t('returns.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** A page of the shop's (OS-07): its title, body and whether it shows, changed or deleted. */
export function PageEditorPage() {
  const { t } = useLocale();
  const { role } = useShop();
  const state = usePageState();
  const { pageId } = useParams({ from: '/$shopId/online-store/pages/$pageId' });
  const query = useAdminQuery<PageData>(['page', pageId], PageQuery, { id: pageId });

  if (!WRITES_PAGES.includes(role)) return <EmptyState title={t('pages.cannot')} />;
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const page = query.data.page;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToPages />
      {!page ? (
        <EmptyState title={t('pages.notFound')} />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
                {page.title}
              </h1>
              <Badge {...state(page)} />
            </div>
            <p className="text-secondary" dir="ltr">
              /pages/{page.handle}
            </p>
          </div>
          <PageForm key={page.id} page={page} />
          <DeletePage page={page} />
        </>
      )}
    </div>
  );
}
