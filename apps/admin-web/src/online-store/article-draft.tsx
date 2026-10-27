import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { ArticleCopyDraftMutation, ArticleCopyDraftingQuery } from '../api/operations';
import type { ArticleCopyDraftData, ArticleCopyDraftingData, CopyLanguage } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';

/**
 * An article written with AI from what the shop wants it to say (MKT-15, ADR-801), in English,
 * Urdu or Roman Urdu: its title and body put in the form in place of theirs, for the shop to
 * check before it saves. Shown only where this Hatti drafts with AI.
 */
export function ArticleDraft({
  blogId,
  title,
  onDraft,
}: {
  blogId: string;
  /** The article's title as the form has it, the topic until one is typed. */
  title: string;
  onDraft: (draft: { title: string; bodyHtml: string }) => void;
}) {
  const { t } = useLocale();
  const drafting = useAdminQuery<ArticleCopyDraftingData>(
    ['articleCopyDrafting'],
    ArticleCopyDraftingQuery,
  );
  const draft = useAdminMutation<ArticleCopyDraftData, { input: Record<string, unknown> }>(
    ArticleCopyDraftMutation,
  );
  const [language, setLanguage] = useState<CopyLanguage>('ENGLISH');
  const [topic, setTopic] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [drafted, setDrafted] = useState(false);

  const state = drafting.data?.articleCopyDrafting;
  if (!state?.available) return null;
  // The day's drafts, and the plan's AI credits this month where they are counted (ADR-533).
  const credits = state.creditsLeft ?? null;
  const left = Math.min(state.limitPerDay - state.usedToday, credits ?? Number.POSITIVE_INFINITY);
  const about = topic ?? title;

  const onWrite = async () => {
    setProblem(null);
    setDrafted(false);
    try {
      const { articleCopyDraft } = await draft.mutateAsync({
        input: { language, topic: about.trim(), notes: notes.trim() || null, blogId },
      });
      if (!articleCopyDraft.draft) {
        setProblem(articleCopyDraft.userErrors[0]?.message ?? t('state.error'));
        return;
      }
      onDraft(articleCopyDraft.draft);
      setDrafted(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-control border border-line p-3">
      <p className="font-medium">{t('articleDraft.title')}</p>
      <TextField
        label={t('articleDraft.topic')}
        hint={t('articleDraft.topicHint')}
        dir="auto"
        maxLength={255}
        value={about}
        onChange={(event) => setTopic(event.target.value)}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="article-draft-notes" className="font-medium">
          {t('articleDraft.notes')}
        </label>
        <p className="text-secondary">{t('articleDraft.notesHint')}</p>
        <textarea
          id="article-draft-notes"
          dir="auto"
          rows={3}
          maxLength={3_500}
          className="rounded-control border border-line bg-surface p-3"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <SelectField<CopyLanguage>
          label={t('copyDraft.language')}
          value={language}
          options={[
            { value: 'ENGLISH', label: t('copyDraft.english') },
            { value: 'URDU', label: t('copyDraft.urdu') },
            { value: 'ROMAN_URDU', label: t('copyDraft.romanUrdu') },
          ]}
          onChange={setLanguage}
        />
        <Button
          variant="secondary"
          busy={draft.isPending}
          disabled={!about.trim() || left <= 0}
          icon={<Sparkles aria-hidden className="size-5" />}
          onClick={() => void onWrite()}
        >
          {t('copyDraft.write')}
        </Button>
      </div>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {credits === 0
          ? t('ai.noCredits')
          : credits !== null
            ? t('ai.creditsLeft', { left: credits, perMonth: state.creditsPerMonth ?? 0 })
            : t('articleDraft.left', { count: Math.max(left, 0) })}
      </p>
      {drafted && <Alert tone="info">{t('articleDraft.drafted')}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}
