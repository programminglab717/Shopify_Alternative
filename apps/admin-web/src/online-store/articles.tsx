import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Ban, Check, Clock, Eye, ImageUp, Trash2, Undo2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  ArticleCreateMutation,
  ArticleDeleteMutation,
  ArticleQuery,
  ArticleUpdateMutation,
  BlogQuery,
  CommentApproveMutation,
  CommentDeleteMutation,
  CommentNotSpamMutation,
  CommentSpamMutation,
  FileQuery,
} from '../api/operations';
import type {
  ArticleComment,
  ArticleData,
  ArticleDetail,
  BlogData,
  CommentStatus,
  ContentMutationData,
  ShopFileData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime, localInput } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { useImageUpload } from '../shell/use-image-upload';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BodyArea, normalized, useBody } from './body-field';
import { usePageState, WRITES_PAGES } from './pages';
import { ArticleUrduCard } from '../urdu/urdu-pages';

type When = 'now' | 'later' | 'hidden';

/** When an article shows: now, from a time ahead, or not at all, as its date says (ADR-215). */
function whenOf(article?: ArticleDetail): When {
  if (!article) return 'now';
  if (!article.publishedAt) return 'hidden';
  return new Date(article.publishedAt).getTime() > Date.now() ? 'later' : 'now';
}

const tagsOf = (text: string) =>
  text
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

/** The article's image: chosen from the phone, shown from the shop's files, or taken away. */
function ArticleImage({
  image,
  onChange,
}: {
  image: { fileId: string; preview?: string } | null;
  onChange: (image: { fileId: string; preview?: string } | null) => void;
}) {
  const { t } = useLocale();
  const upload = useImageUpload();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const file = useAdminQuery<ShopFileData>(
    ['file', image?.fileId],
    FileQuery,
    { id: image?.fileId ?? '' },
    { enabled: Boolean(image && !image.preview) },
  );
  const src = image?.preview ?? file.data?.file?.url;

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    setBusy(true);
    setProblem(null);
    void upload(chosen, t('articles.image'))
      .then((made) => {
        if ('problem' in made) setProblem(made.problem);
        else onChange({ fileId: made.id, preview: URL.createObjectURL(chosen) });
      })
      .catch((failure: unknown) => setProblem(errorText(failure, t)))
      .finally(() => setBusy(false));
  };

  return (
    <FormSection title={t('articles.image')} hint={t('articles.imageHint')}>
      {image && src && (
        <img
          src={src}
          alt={t('articles.image')}
          className="max-h-48 self-start rounded-control border border-line object-contain"
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={<ImageUp aria-hidden className="size-5" />}
          busy={busy}
          onClick={() => input.current?.click()}
        >
          {t(image ? 'articles.imageReplace' : 'articles.imageChoose')}
        </Button>
        {image && (
          <Button
            variant="danger"
            icon={<Trash2 aria-hidden className="size-5" />}
            disabled={busy}
            onClick={() => onChange(null)}
          >
            {t('articles.imageRemove')}
          </Button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={t('articles.image')}
        onChange={onChosen}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/**
 * An article's title, body, author, tags and image, and when it shows: now, from a time ahead in
 * the phone's own time, or not at all. The body is written as text, as pages are.
 */
function ArticleForm({ blogId, article }: { blogId: string; article?: ArticleDetail }) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const create = useAdminMutation<ContentMutationData, { article: Record<string, unknown> }>(
    ArticleCreateMutation,
  );
  const update = useAdminMutation<
    ContentMutationData,
    { id: string; article: Record<string, unknown> }
  >(ArticleUpdateMutation);
  const { problem, attempt } = useAttempt();
  const body = useBody(article?.body ?? '');
  const [title, setTitle] = useState(article?.title ?? '');
  const [author, setAuthor] = useState(article?.author?.name ?? '');
  const [tags, setTags] = useState(article?.tags.join(', ') ?? '');
  const [image, setImage] = useState<{ fileId: string; preview?: string } | null>(
    article?.image ? { fileId: article.image.fileId } : null,
  );
  const startedWhen = whenOf(article);
  const [when, setWhen] = useState<When>(startedWhen);
  const [at, setAt] = useState(
    article?.publishedAt && startedWhen === 'later' ? localInput(article.publishedAt) : '',
  );
  const [saved, setSaved] = useState(false);

  const publishDate = when === 'later' && at ? new Date(at).toISOString() : null;
  const visibility =
    when === 'hidden'
      ? { isPublished: false }
      : when === 'later'
        ? { isPublished: true, ...(publishDate && { publishDate }) }
        : {
            isPublished: true,
            ...(startedWhen === 'later' && { publishDate: new Date().toISOString() }),
          };
  const imageInput = image ? { fileId: image.fileId, altText: title.trim() } : null;
  const input = article
    ? {
        ...(title.trim() !== article.title && { title: title.trim() }),
        ...(body.html !== normalized(article.body) && { body: body.html }),
        ...(author.trim() !== (article.author?.name ?? '') && {
          author: author.trim() ? { name: author.trim() } : null,
        }),
        ...(tagsOf(tags).join(',') !== article.tags.join(',') && { tags: tagsOf(tags) }),
        ...(image?.fileId !== article.image?.fileId && { image: imageInput }),
        ...((when !== startedWhen ||
          (when === 'later' && publishDate !== null && at !== localInput(article.publishedAt!))) &&
          visibility),
      }
    : {
        blogId,
        title: title.trim(),
        body: body.html,
        ...(author.trim() && { author: { name: author.trim() } }),
        ...(tagsOf(tags).length > 0 && { tags: tagsOf(tags) }),
        ...(imageInput && { image: imageInput }),
        ...visibility,
      };
  const changed = Object.keys(input).length > 0;
  const ready = title.trim() !== '' && changed && (when !== 'later' || publishDate !== null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSaved(false);
    const made: { id?: string } = {};
    const ok = await attempt(async () => {
      const payload = Object.values(
        article
          ? await update.mutateAsync({ id: article.id, article: input })
          : await create.mutateAsync({ article: input }),
      )[0]!;
      made.id = payload.article?.id;
      return payload;
    });
    if (!ok) return;
    if (article) setSaved(true);
    else if (made.id) {
      await navigate({
        to: '/$shopId/online-store/articles/$articleId',
        params: { shopId, articleId: made.id },
      });
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('pages.content')}>
        <TextField
          label={t('articles.titleLabel')}
          required
          dir="auto"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <BodyArea body={body} label={t('articles.body')} />
        <TextField
          label={t('articles.author')}
          hint={t('articles.authorHint')}
          dir="auto"
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
        />
        <TextField
          label={t('articles.tags')}
          hint={t('articles.tagsHint')}
          dir="auto"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
      </FormSection>
      <ArticleImage image={image} onChange={setImage} />
      <FormSection title={t('pages.visibility')}>
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">{t('pages.visibility')}</legend>
          {(['now', 'later', 'hidden'] as const).map((each) => (
            <label key={each} className="flex min-h-10 items-center gap-2">
              <input
                type="radio"
                name="when"
                checked={when === each}
                onChange={() => setWhen(each)}
                className="size-5 accent-[var(--hatti-color-primary)]"
              />
              {t(`articles.when.${each}` as MessageKey)}
            </label>
          ))}
        </fieldset>
        {when === 'later' && (
          <TextField
            label={t('articles.at')}
            hint={t('articles.atHint')}
            type="datetime-local"
            ltr
            required
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        )}
      </FormSection>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {saved && !changed && <Alert tone="success">{t('articles.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={create.isPending || update.isPending}
        disabled={!ready}
      >
        {t(article ? 'articles.save' : 'articles.create')}
      </Button>
    </form>
  );
}

function BackToBlog({ blog }: { blog: { id: string; title: string } }) {
  const { id: shopId } = useShop();
  return (
    <Link
      to="/$shopId/online-store/blogs/$blogId"
      params={{ shopId, blogId: blog.id }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      <span dir="auto">{blog.title}</span>
    </Link>
  );
}

/** A new article in a blog (OS-07), for those who write the shop's content. */
export function NewArticlePage() {
  const { t } = useLocale();
  const { role } = useShop();
  const { blogId } = useParams({ from: '/$shopId/online-store/blogs/$blogId/articles/new' });
  const query = useAdminQuery<BlogData>(['blog', blogId], BlogQuery, { id: blogId });
  if (!WRITES_PAGES.includes(role)) return <EmptyState title={t('pages.cannot')} />;
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError || !query.data.blog) {
    return <ErrorState message={query.isError ? errorText(query.error, t) : t('blogs.notFound')} />;
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToBlog blog={query.data.blog} />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('articles.add')}
      </h1>
      <ArticleForm blogId={blogId} />
    </div>
  );
}

const STATUS: Record<
  CommentStatus,
  { colour: 'needsConfirmation' | 'delivered' | 'cancelled'; icon: typeof Clock }
> = {
  PENDING: { colour: 'needsConfirmation', icon: Clock },
  PUBLISHED: { colour: 'delivered', icon: Eye },
  SPAM: { colour: 'cancelled', icon: Ban },
};

/** A comment, with what can be done with it as it stands: shown, marked spam, or deleted. */
function CommentRow({ comment }: { comment: ArticleComment }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const approve = useAdminMutation<ContentMutationData, { id: string }>(CommentApproveMutation);
  const spam = useAdminMutation<ContentMutationData, { id: string }>(CommentSpamMutation);
  const notSpam = useAdminMutation<ContentMutationData, { id: string }>(CommentNotSpamMutation);
  const remove = useAdminMutation<ContentMutationData, { id: string }>(CommentDeleteMutation);
  const { problem, attempt } = useAttempt();
  const [asking, setAsking] = useState(false);
  const act = (mutation: typeof approve) =>
    void attempt(async () => Object.values(await mutation.mutateAsync({ id: comment.id }))[0]!);
  const busy = approve.isPending || spam.isPending || notSpam.isPending || remove.isPending;

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-col">
          <span className="font-medium" dir="auto">
            {comment.author.name}
          </span>
          <span className="text-secondary">
            <span dir="ltr">{comment.author.email}</span> ·{' '}
            {formatDateTime(comment.createdAt, timezone, locale)}
          </span>
        </span>
        <Badge
          {...STATUS[comment.status]}
          label={t(`comments.status.${comment.status}` as MessageKey)}
        />
      </div>
      <p className="whitespace-pre-line" dir="auto">
        {comment.body}
      </p>
      {asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t('comments.deleteAsk')}</span>
          <Button variant="destructive" busy={remove.isPending} onClick={() => act(remove)}>
            {t('comments.deleteConfirm')}
          </Button>
          <Button variant="tertiary" onClick={() => setAsking(false)}>
            {t('returns.cancel')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {comment.status === 'PENDING' && (
            <Button
              variant="secondary"
              icon={<Check aria-hidden className="size-5" />}
              disabled={busy}
              onClick={() => act(approve)}
            >
              {t('comments.approve')}
            </Button>
          )}
          {comment.status === 'SPAM' ? (
            <Button
              variant="tertiary"
              icon={<Undo2 aria-hidden className="size-5" />}
              disabled={busy}
              onClick={() => act(notSpam)}
            >
              {t('comments.notSpam')}
            </Button>
          ) : (
            <Button
              variant="tertiary"
              icon={<Ban aria-hidden className="size-5" />}
              disabled={busy}
              onClick={() => act(spam)}
            >
              {t('comments.spam')}
            </Button>
          )}
          <Button
            variant="danger"
            icon={<Trash2 aria-hidden className="size-5" />}
            disabled={busy}
            onClick={() => setAsking(true)}
          >
            {t('comments.delete')}
          </Button>
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/** The article's comments, the latest first; those waiting for the shop say so. */
function Comments({ article }: { article: ArticleDetail }) {
  const { t } = useLocale();
  const comments = article.comments.nodes;
  const waiting = comments.filter((comment) => comment.status === 'PENDING').length;
  return (
    <section aria-label={t('comments.title')} className="flex flex-col gap-3">
      <h2 className="font-semibold">{t('comments.title')}</h2>
      {article.blog.commentPolicy === 'CLOSED' && (
        <p className="text-secondary">{t('comments.closed')}</p>
      )}
      {waiting > 0 && <Alert tone="info">{t('comments.waiting', { count: waiting })}</Alert>}
      {comments.length === 0 ? (
        article.blog.commentPolicy !== 'CLOSED' && (
          <p className="text-secondary">{t('comments.none')}</p>
        )
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {comments.map((comment) => (
              <CommentRow key={comment.id} comment={comment} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

/** The article deleted after asking; its comments go with it. */
function DeleteArticle({ article }: { article: ArticleDetail }) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const remove = useAdminMutation<ContentMutationData, { id: string }>(ArticleDeleteMutation);
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
        {t('articles.delete')}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <p>{t('articles.deleteAsk', { title: article.title })}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          busy={remove.isPending}
          onClick={() =>
            void (async () => {
              const ok = await attempt(
                async () => Object.values(await remove.mutateAsync({ id: article.id }))[0]!,
              );
              if (ok) {
                await navigate({
                  to: '/$shopId/online-store/blogs/$blogId',
                  params: { shopId, blogId: article.blog.id },
                });
              }
            })()
          }
        >
          {t('articles.deleteConfirm')}
        </Button>
        <Button variant="tertiary" onClick={() => setAsking(false)}>
          {t('returns.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** An article of the shop's (OS-07): written and scheduled, its comments moderated, or deleted. */
export function ArticleEditorPage() {
  const { t } = useLocale();
  const { role } = useShop();
  const state = usePageState();
  const { articleId } = useParams({ from: '/$shopId/online-store/articles/$articleId' });
  const query = useAdminQuery<ArticleData>(['article', articleId], ArticleQuery, { id: articleId });

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
  const article = query.data.article;
  if (!article) return <EmptyState title={t('articles.notFound')} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToBlog blog={article.blog} />
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
            {article.title}
          </h1>
          <Badge {...state(article)} />
        </div>
        <p className="text-secondary" dir="ltr">
          /blogs/{article.blog.handle}/{article.handle}
        </p>
      </div>
      <ArticleForm key={article.id} blogId={article.blog.id} article={article} />
      <ArticleUrduCard articleId={article.id} />
      <Comments article={article} />
      <DeleteArticle article={article} />
    </div>
  );
}
