import { Tag, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ConversationLabelsQuery, ConversationLabelsSetMutation } from '../api/operations';
import type {
  ConversationLabelValue,
  ConversationUpdatePayload,
  ConversationValue,
} from '../api/types';
import { errorText, userErrorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';

/** How many labels a conversation has at most, and how long each is, as the API takes them. */
export const LABEL_LIMITS = { perConversation: 10, length: 40 } as const;

/** A conversation's label, as a small tag. */
export function LabelChip({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-canvas px-2 py-0.5 text-[length:var(--hatti-type-caption-size)] text-secondary">
      <Tag aria-hidden className="size-3 shrink-0" />
      <span dir="auto" className="truncate">
        {label}
      </span>
    </span>
  );
}

/**
 * What the customer writes about (MSG-06, ADR-764): the conversation's labels, which those who
 * work the inbox add and take off, suggested from the labels the shop uses; marketers see them.
 */
export function ConversationLabels({
  conversation,
  works,
}: {
  conversation: ConversationValue;
  works: boolean;
}) {
  const { t } = useLocale();
  const known = useAdminQuery<{ conversationLabels: ConversationLabelValue[] }>(
    ['conversationLabels'],
    ConversationLabelsQuery,
    undefined,
    { enabled: works },
  );
  const save = useAdminMutation<
    { conversationLabelsSet: ConversationUpdatePayload },
    { id: string; labels: string[] }
  >(ConversationLabelsSetMutation);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const labels = conversation.labels;
  const full = labels.length >= LABEL_LIMITS.perConversation;

  const put = async (next: string[]) => {
    setProblem(null);
    try {
      const { conversationLabelsSet } = await save.mutateAsync({
        id: conversation.id,
        labels: next,
      });
      if (conversationLabelsSet.userErrors[0]) {
        setProblem(userErrorText(conversationLabelsSet.userErrors[0], t));
        return false;
      }
      return true;
    } catch (failure) {
      setProblem(errorText(failure, t));
      return false;
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const label = draft.trim();
    if (!label) return;
    if (labels.some((each) => each.toLowerCase() === label.toLowerCase())) {
      setDraft('');
      return;
    }
    if (await put([...labels, label])) setDraft('');
  };

  if (!works) {
    return labels.length > 0 ? (
      <ul aria-label={t('inbox.labels')} className="flex flex-wrap gap-2">
        {labels.map((label) => (
          <li key={label}>
            <LabelChip label={label} />
          </li>
        ))}
      </ul>
    ) : null;
  }
  const suggestions = (known.data?.conversationLabels ?? []).filter(
    (each) => !labels.some((label) => label.toLowerCase() === each.name.toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-2">
      {labels.length > 0 && (
        <ul aria-label={t('inbox.labels')} className="flex flex-wrap gap-2">
          {labels.map((label) => (
            <li
              key={label}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface ps-2"
            >
              <Tag aria-hidden className="size-4 text-secondary" />
              <span dir="auto">{label}</span>
              <button
                type="button"
                aria-label={t('inbox.labelRemove', { label })}
                disabled={save.isPending}
                onClick={() => void put(labels.filter((each) => each !== label))}
                className="inline-flex size-8 items-center justify-center rounded-full text-secondary hover:text-text"
              >
                <X aria-hidden className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <form onSubmit={(event) => void add(event)} className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextField
              label={t('inbox.labelAdd')}
              value={draft}
              maxLength={LABEL_LIMITS.length}
              list="conversation-labels"
              autoComplete="off"
              onChange={(event) => setDraft(event.target.value)}
            />
            <datalist id="conversation-labels">
              {suggestions.map((each) => (
                <option key={each.name} value={each.name} />
              ))}
            </datalist>
          </div>
          <Button type="submit" variant="secondary" busy={save.isPending} disabled={!draft.trim()}>
            {t('inbox.labelAddAction')}
          </Button>
        </form>
      )}
      {!full && labels.length === 0 && (
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('inbox.labelHint')}
        </p>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/** The inbox's labels to show the conversations of one by, with how many open ones have each. */
export function LabelFilter({
  labels,
  chosen,
  onChoose,
}: {
  labels: ConversationLabelValue[];
  chosen: string | null;
  onChoose: (label: string | null) => void;
}) {
  const { t } = useLocale();
  if (labels.length === 0 && chosen === null) return null;
  const shown =
    chosen !== null && !labels.some((each) => each.name === chosen)
      ? [{ name: chosen, open: 0 }, ...labels]
      : labels;
  const pill = (active: boolean) =>
    `inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-[length:var(--hatti-type-body-sm-size)] ${
      active
        ? 'border-primary bg-surface font-medium text-primary'
        : 'border-line bg-surface text-text'
    }`;
  return (
    <div role="group" aria-label={t('inbox.labels')} className="flex gap-2 overflow-x-auto pb-1">
      <button
        type="button"
        aria-pressed={chosen === null}
        onClick={() => onChoose(null)}
        className={pill(chosen === null)}
      >
        {t('inbox.labelAll')}
      </button>
      {shown.map((each) => (
        <button
          key={each.name}
          type="button"
          aria-pressed={chosen === each.name}
          onClick={() => onChoose(each.name)}
          className={pill(chosen === each.name)}
        >
          <Tag aria-hidden className="size-4" />
          <span dir="auto">{each.name}</span>
          {each.open > 0 && <span className="num text-secondary">{formatCount(each.open)}</span>}
        </button>
      ))}
    </div>
  );
}
