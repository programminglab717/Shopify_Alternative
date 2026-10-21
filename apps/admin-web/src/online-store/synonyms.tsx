import { useSearch } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { SearchSynonymsQuery, SearchSynonymsSetMutation } from '../api/operations';
import type { SearchSynonymsData, SearchSynonymsSetData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { Problems } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** What the core takes: 100 groups at most (ADR-685). */
const MAX_GROUPS = 100;

interface GroupDraft {
  key: number;
  text: string;
}

/** A group's words as the merchant typed them, between commas, Urdu's among them. */
export function wordsOf(text: string): string[] {
  return text
    .split(/[,،]/u)
    .map((word) => word.trim())
    .filter((word) => word !== '');
}

const textOf = (words: readonly string[]) => words.join(', ');

/** The groups, as typed, saved whole; a word from a search that found nothing starts a new one. */
function SynonymsForm({ groups, word }: { groups: { words: string[] }[]; word?: string }) {
  const { t } = useLocale();
  const set = useAdminMutation<SearchSynonymsSetData, { groups: { words: string[] }[] }>(
    SearchSynonymsSetMutation,
  );
  const next = useRef(0);
  const draftsOf = (list: { words: string[] }[]): GroupDraft[] =>
    list.map((group) => ({ key: (next.current += 1), text: textOf(group.words) }));
  const [kept, setKept] = useState(groups);
  const [drafts, setDrafts] = useState(() => [
    ...draftsOf(groups),
    // Come from analytics with a search that found nothing: a group begun with its words.
    ...(word ? [{ key: (next.current += 1), text: `${word}, ` }] : []),
  ]);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const input = drafts
    .map((draft) => ({ words: wordsOf(draft.text) }))
    .filter((group) => group.words.length > 0);
  const changed = JSON.stringify(input) !== JSON.stringify(kept);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setErrors({});
    setProblems([]);
    setSaved(false);
    // The groups sent, by their place, to put what the core says under each.
    const sent = drafts.filter((draft) => wordsOf(draft.text).length > 0);
    try {
      const { searchSynonymsSet: result } = await set.mutateAsync({ groups: input });
      if (result.userErrors.length > 0) {
        const byGroup: Record<number, string> = {};
        const rest: string[] = [];
        for (const error of result.userErrors) {
          const [list, at] = error.field ?? [];
          const draft = list === 'groups' && at !== undefined ? sent[Number(at)] : undefined;
          if (draft) {
            byGroup[draft.key] = byGroup[draft.key]
              ? `${byGroup[draft.key]} ${error.message}`
              : error.message;
          } else {
            rest.push(error.message);
          }
        }
        setErrors(byGroup);
        setProblems(rest);
        return;
      }
      const now = result.searchSynonyms ?? [];
      setKept(now);
      setDrafts(draftsOf(now));
      setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <FormSection title={t('synonyms.title')} hint={t('synonyms.intro')}>
        {drafts.length === 0 ? (
          <p className="text-secondary">{t('synonyms.none')}</p>
        ) : (
          <ol aria-label={t('synonyms.title')} className="flex flex-col gap-3">
            {drafts.map((draft, index) => (
              <li key={draft.key} className="flex items-end gap-2">
                <TextField
                  className="min-w-0 flex-1"
                  label={t('synonyms.group', { number: index + 1 })}
                  hint={index === 0 ? t('synonyms.groupHint') : undefined}
                  dir="auto"
                  value={draft.text}
                  error={errors[draft.key]}
                  // A group begun from a search goes straight to its next word.
                  autoFocus={Boolean(word) && index === drafts.length - 1}
                  onChange={(event) =>
                    setDrafts((all) =>
                      all.map((each) =>
                        each.key === draft.key ? { ...each, text: event.target.value } : each,
                      ),
                    )
                  }
                />
                <Button
                  variant="danger"
                  aria-label={t('synonyms.remove', { number: index + 1 })}
                  icon={<Trash2 aria-hidden className="size-5" />}
                  onClick={() => setDrafts((all) => all.filter((each) => each.key !== draft.key))}
                >
                  {t('synonyms.removeShort')}
                </Button>
              </li>
            ))}
          </ol>
        )}
        <Button
          variant="secondary"
          className="self-start"
          disabled={drafts.length >= MAX_GROUPS}
          icon={<Plus aria-hidden className="size-5" />}
          onClick={() => setDrafts((all) => [...all, { key: (next.current += 1), text: '' }])}
        >
          {t('synonyms.add')}
        </Button>
        <Problems problems={problems} />
        {saved && !changed && <Alert tone="success">{t('storefront.saved')}</Alert>}
        <Button type="submit" className="self-start" busy={set.isPending} disabled={!changed}>
          {t('synonyms.save')}
        </Button>
      </FormSection>
    </form>
  );
}

/**
 * The shop's own search synonyms (SRC-04, ADR-686), for those who change products: groups of
 * words its storefront's search reads as meaning the same, beside the words Hatti knows.
 */
export function SynonymsTab() {
  const { t } = useLocale();
  const search = useSearch({ from: '/$shopId/online-store' });
  const query = useAdminQuery<SearchSynonymsData>(['searchSynonyms'], SearchSynonymsQuery);
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  return <SynonymsForm groups={query.data.searchSynonyms} word={search.word} />;
}
