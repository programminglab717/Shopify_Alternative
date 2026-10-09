import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, MessageSquare, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  BlogCreateMutation,
  BlogDeleteMutation,
  BlogQuery,
  BlogsQuery,
  BlogUpdateMutation,
} from '../api/operations';
import type {
  BlogData,
  BlogsData,
  BlogSummary,
  CommentPolicy,
  ContentMutationData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { usePageState, WRITES_PAGES } from './pages';
import { BlogUrduCard } from '../urdu/urdu-pages';

const POLICIES: readonly CommentPolicy[] = ['MODERATED', 'AUTO_PUBLISHED', 'CLOSED'];

/** A new blog, started by its title; its articles are written from its page. */
function NewBlog() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const create = useAdminMutation<ContentMutationData, { blog: { title: string } }>(
    BlogCreateMutation,
  );
  const { problem, attempt } = useAttempt();
  const [title, setTitle] = useState('');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const made: { id?: string } = {};
    const ok = await attempt(async () => {
      const payload = Object.values(
        await create.mutateAsync({ blog: { title: title.trim() } }),
      )[0]!;
      made.id = payload.blog?.id;
      return payload;
    });
    if (ok && made.id) {
      await navigate({
        to: '/$shopId/online-store/blogs/$blogId',
        params: { shopId, blogId: made.id },
      });
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <TextField
          label={t('blogs.newTitle')}
          hint={t('blogs.newTitleHint')}
          dir="auto"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button
          type="submit"
          className="self-start"
          icon={<Plus aria-hidden className="size-5" />}
          busy={create.isPending}
          disabled={!title.trim()}
        >
          {t('blogs.add')}
        </Button>
      </form>
    </Card>
  );
}

/** The shop's blogs (OS-07), each with how many articles it has; a new one started here. */
export function BlogsList() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const query = useAdminQuery<BlogsData>(['blogs'], BlogsQuery);

  return (
    <div className="flex flex-col gap-3">
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.blogs.nodes.length === 0 ? (
        <Card>
          <EmptyState title={t('blogs.none')} />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.blogs.nodes.map((blog) => (
              <li key={blog.id}>
                <Link
                  to="/$shopId/online-store/blogs/$blogId"
                  params={{ shopId, blogId: blog.id }}
                  className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 hover:bg-canvas"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium" dir="auto">
                      {blog.title}
                    </span>
                    <span className="text-secondary" dir="ltr">
                      /blogs/{blog.handle}
                    </span>
                  </span>
                  <span className="text-secondary">
                    {t('blogs.articlesCount', { count: blog.articlesCount })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <NewBlog />
    </div>
  );
}

export function BackToBlogs() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  return (
    <Link
      to="/$shopId/online-store"
      params={{ shopId }}
      search={{ tab: 'blogs' }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('blogs.back')}
    </Link>
  );
}

/** A blog's title and whether its articles take comments, and whether they wait to be approved. */
function BlogForm({ blog }: { blog: BlogSummary }) {
  const { t } = useLocale();
  const update = useAdminMutation<
    ContentMutationData,
    { id: string; blog: Partial<Pick<BlogSummary, 'title' | 'commentPolicy'>> }
  >(BlogUpdateMutation);
  const { problem, attempt } = useAttempt();
  const [title, setTitle] = useState(blog.title);
  const [policy, setPolicy] = useState(blog.commentPolicy);
  const [saved, setSaved] = useState(false);
  const input = {
    ...(title.trim() !== blog.title && { title: title.trim() }),
    ...(policy !== blog.commentPolicy && { commentPolicy: policy }),
  };
  const changed = Object.keys(input).length > 0;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !title.trim()) return;
    setSaved(false);
    const ok = await attempt(
      async () => Object.values(await update.mutateAsync({ id: blog.id, blog: input }))[0]!,
    );
    if (ok) setSaved(true);
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('blogs.settings')}>
        <TextField
          label={t('blogs.titleLabel')}
          required
          dir="auto"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium">{t('blogs.comments')}</legend>
          {POLICIES.map((each) => (
            <label key={each} className="flex min-h-10 items-start gap-2 py-1">
              <input
                type="radio"
                name="commentPolicy"
                checked={policy === each}
                onChange={() => setPolicy(each)}
                className="mt-0.5 size-5 shrink-0 accent-[var(--hatti-color-primary)]"
              />
              <span className="flex flex-col">
                <span>{t(`blogs.policy.${each}` as MessageKey)}</span>
                <span className="text-secondary">
                  {t(`blogs.policyHint.${each}` as MessageKey)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      </FormSection>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {saved && !changed && <Alert tone="success">{t('blogs.saved')}</Alert>}
      <Button type="submit" className="self-start" busy={update.isPending} disabled={!changed}>
        {t('blogs.save')}
      </Button>
    </form>
  );
}

/** The blog deleted after saying its articles and their comments go with it. */
function DeleteBlog({ blog }: { blog: BlogSummary }) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const remove = useAdminMutation<ContentMutationData, { id: string }>(BlogDeleteMutation);
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
        {t('blogs.delete')}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <p>{t('blogs.deleteAsk', { title: blog.title, count: blog.articlesCount })}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          busy={remove.isPending}
          onClick={() =>
            void (async () => {
              const ok = await attempt(
                async () => Object.values(await remove.mutateAsync({ id: blog.id }))[0]!,
              );
              if (ok) {
                await navigate({
                  to: '/$shopId/online-store',
                  params: { shopId },
                  search: { tab: 'blogs' },
                });
              }
            })()
          }
        >
          {t('blogs.deleteConfirm')}
        </Button>
        <Button variant="tertiary" onClick={() => setAsking(false)}>
          {t('returns.cancel')}
        </Button>
      </div>
    </div>
  );
}

/**
 * A blog of the shop's (OS-07): its articles, each shown, waiting for its date or hidden, with its
 * comments; a new one written from here; its title and comments changed; and the blog deleted.
 */
export function BlogPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  const state = usePageState();
  const { blogId } = useParams({ from: '/$shopId/online-store/blogs/$blogId' });
  const query = useAdminQuery<BlogData>(['blog', blogId], BlogQuery, { id: blogId });

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
  const blog = query.data.blog;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToBlogs />
      {!blog ? (
        <EmptyState title={t('blogs.notFound')} />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
              {blog.title}
            </h1>
            <p className="text-secondary" dir="ltr">
              /blogs/{blog.handle}
            </p>
          </div>
          <BlogUrduCard blogId={blog.id} />
          <section aria-label={t('blogs.articles')} className="flex flex-col gap-3">
            <Link
              to="/$shopId/online-store/blogs/$blogId/articles/new"
              params={{ shopId, blogId: blog.id }}
              className="inline-flex min-h-12 items-center gap-2 self-start rounded-control bg-primary px-4 font-medium text-on-primary hover:bg-primary-strong md:min-h-10"
            >
              <Plus aria-hidden className="size-5" />
              {t('articles.add')}
            </Link>
            {blog.articles.nodes.length === 0 ? (
              <Card>
                <EmptyState title={t('articles.none')} />
              </Card>
            ) : (
              <Card>
                <ul className="divide-y divide-line">
                  {blog.articles.nodes.map((article) => (
                    <li key={article.id}>
                      <Link
                        to="/$shopId/online-store/articles/$articleId"
                        params={{ shopId, articleId: article.id }}
                        className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 hover:bg-canvas"
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="font-medium" dir="auto">
                            {article.title}
                          </span>
                          {article.commentsCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-secondary">
                              <MessageSquare aria-hidden className="size-4" />
                              {t('articles.commentsCount', { count: article.commentsCount })}
                            </span>
                          )}
                        </span>
                        <Badge {...state(article)} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
          <BlogForm key={blog.id} blog={blog} />
          <DeleteBlog blog={blog} />
        </>
      )}
    </div>
  );
}
