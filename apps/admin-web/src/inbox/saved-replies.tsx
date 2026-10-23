/** The inbox's saved replies (MSG-06, ADR-758): kept on their own tab, and picked while answering. */
import { BookmarkPlus, MessageSquareText, Pencil, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  SavedRepliesQuery,
  SavedReplyCreateMutation,
  SavedReplyDeleteMutation,
  SavedReplyUpdateMutation,
} from '../api/operations';
import type {
  SavedRepliesData,
  SavedReplyDeleteData,
  SavedReplyPayload,
  SavedReplyValue,
} from '../api/types';
import { errorText, userErrorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** The longest title, and the longest reply, as WhatsApp takes one. */
const TITLE_MAX = 60;
const BODY_MAX = 4096;

type Input = { title: string; body: string };

/** A saved reply's title and words, to keep a new one or change one kept. */
function ReplyForm({ reply, onDone }: { reply: SavedReplyValue | null; onDone: () => void }) {
  const { t } = useLocale();
  const bodyId = useId();
  const create = useAdminMutation<{ savedReplyCreate: SavedReplyPayload }, { input: Input }>(
    SavedReplyCreateMutation,
  );
  const update = useAdminMutation<
    { savedReplyUpdate: SavedReplyPayload },
    { id: string; input: Input }
  >(SavedReplyUpdateMutation);
  const [title, setTitle] = useState(reply?.title ?? '');
  const [body, setBody] = useState(reply?.body ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const input = { title, body };
    try {
      const payload = reply
        ? (await update.mutateAsync({ id: reply.id, input })).savedReplyUpdate
        : (await create.mutateAsync({ input })).savedReplyCreate;
      if (payload.userErrors[0]) setProblem(userErrorText(payload.userErrors[0], t));
      else {
        setTitle('');
        setBody('');
        onDone();
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <TextField
        label={t('savedReplies.title')}
        hint={t('savedReplies.titleHint')}
        dir="auto"
        maxLength={TITLE_MAX}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label htmlFor={bodyId} className="font-medium">
        {t('savedReplies.body')}
      </label>
      <textarea
        id={bodyId}
        value={body}
        rows={4}
        dir="auto"
        maxLength={BODY_MAX}
        onChange={(event) => setBody(event.target.value)}
        className="rounded-control border border-line bg-surface px-3 py-2 text-text"
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          busy={create.isPending || update.isPending}
          disabled={!title.trim() || !body.trim()}
        >
          {t(reply ? 'savedReplies.save' : 'savedReplies.add')}
        </Button>
        {reply && (
          <Button variant="tertiary" onClick={onDone}>
            {t('returns.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

/** A saved reply on its tab: read by all who read the inbox, changed by those who answer. */
function ReplyRow({ reply, works }: { reply: SavedReplyValue; works: boolean }) {
  const { t } = useLocale();
  const remove = useAdminMutation<SavedReplyDeleteData, { id: string }>(SavedReplyDeleteMutation);
  const [mode, setMode] = useState<'show' | 'edit' | 'delete'>('show');
  const [problem, setProblem] = useState<string | null>(null);

  const onDelete = async () => {
    setProblem(null);
    try {
      const { savedReplyDelete } = await remove.mutateAsync({ id: reply.id });
      if (savedReplyDelete.userErrors[0]) {
        setProblem(userErrorText(savedReplyDelete.userErrors[0], t));
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  if (mode === 'edit') {
    return (
      <li className="p-4">
        <ReplyForm reply={reply} onDone={() => setMode('show')} />
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-2 p-4">
      <h3 className="font-semibold" dir="auto">
        {reply.title}
      </h3>
      <p className="whitespace-pre-wrap text-secondary" dir="auto">
        {reply.body}
      </p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {works &&
        (mode === 'delete' ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('savedReplies.deleteSure', { title: reply.title })}</span>
            <Button variant="destructive" busy={remove.isPending} onClick={() => void onDelete()}>
              {t('savedReplies.delete')}
            </Button>
            <Button variant="tertiary" onClick={() => setMode('show')}>
              {t('savedReplies.keep')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={<Pencil aria-hidden className="size-4" />}
              aria-label={t('savedReplies.editOf', { title: reply.title })}
              onClick={() => setMode('edit')}
            >
              {t('savedReplies.edit')}
            </Button>
            <Button
              variant="tertiary"
              icon={<Trash2 aria-hidden className="size-4" />}
              aria-label={t('savedReplies.deleteOf', { title: reply.title })}
              onClick={() => setMode('delete')}
            >
              {t('savedReplies.delete')}
            </Button>
          </div>
        ))}
    </li>
  );
}

/**
 * The inbox's Saved replies tab: what the shop answers with again and again, by title, kept,
 * changed and deleted by those who answer customers; marketers read them.
 */
export function SavedReplies({ works }: { works: boolean }) {
  const { t } = useLocale();
  const replies = useAdminQuery<SavedRepliesData>(['savedReplies'], SavedRepliesQuery);
  const kept = replies.data?.savedReplies ?? [];

  return (
    <div className="flex flex-col gap-4">
      {works && (
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="font-semibold">{t('savedReplies.new')}</h2>
          <p className="text-secondary">{t('savedReplies.newHint')}</p>
          <ReplyForm reply={null} onDone={() => undefined} />
        </Card>
      )}
      {replies.isPending ? (
        <Loading label={t('state.loading')} />
      ) : replies.isError ? (
        <ErrorState
          message={errorText(replies.error, t)}
          action={<Button onClick={() => void replies.refetch()}>{t('action.retry')}</Button>}
        />
      ) : kept.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BookmarkPlus aria-hidden className="size-8 text-secondary" />}
            title={t('savedReplies.none')}
            body={t('savedReplies.noneHint')}
          />
        </Card>
      ) : (
        <Card>
          <p className="border-b border-line p-4 text-secondary">
            {t('savedReplies.count', { count: formatCount(kept.length) })}
          </p>
          <ul className="divide-y divide-line">
            {kept.map((reply) => (
              <ReplyRow key={reply.id} reply={reply} works={works} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/**
 * The shop's saved replies offered while answering, found by any of their words: the one picked
 * is put in the reply, to change before sending.
 */
export function SavedReplyPicker({ onPick }: { onPick: (body: string) => void }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState('');
  const replies = useAdminQuery<SavedRepliesData>(['savedReplies'], SavedRepliesQuery);
  const kept = replies.data?.savedReplies ?? [];
  const needle = words.trim().toLocaleLowerCase();
  const found = needle
    ? kept.filter((reply) => `${reply.title}\n${reply.body}`.toLocaleLowerCase().includes(needle))
    : kept;

  if (!open) {
    return (
      <Button
        variant="tertiary"
        icon={<MessageSquareText aria-hidden className="size-5" />}
        onClick={() => setOpen(true)}
      >
        {t('savedReplies.pick')}
      </Button>
    );
  }
  return (
    <Card className="flex w-full flex-col gap-2 p-3">
      <TextField
        label={t('savedReplies.find')}
        dir="auto"
        value={words}
        onChange={(event) => setWords(event.target.value)}
      />
      {replies.isPending ? (
        <p className="text-secondary">{t('state.loading')}</p>
      ) : kept.length === 0 ? (
        <p className="text-secondary">{t('savedReplies.pickNone')}</p>
      ) : found.length === 0 ? (
        <p className="text-secondary">{t('savedReplies.pickNoMatch')}</p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {found.map((reply) => (
            <li key={reply.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(reply.body);
                  setOpen(false);
                  setWords('');
                }}
                className="flex min-h-10 w-full flex-col items-start rounded-control px-2 py-1 text-start hover:bg-canvas"
              >
                <span className="font-medium" dir="auto">
                  {reply.title}
                </span>
                <span className="line-clamp-2 text-secondary" dir="auto">
                  {reply.body}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="tertiary" onClick={() => setOpen(false)}>
          {t('returns.cancel')}
        </Button>
      </div>
    </Card>
  );
}
