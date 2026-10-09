import { Bookmark, BookmarkPlus, Pencil, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  DraftOrderSavedSearchesQuery,
  OrderSavedSearchesQuery,
  ProductSavedSearchesQuery,
  SavedSearchCreateMutation,
  SavedSearchDeleteMutation,
  SavedSearchUpdateMutation,
} from '../api/operations';
import type { SavedSearch, SavedSearchesData, SavedSearchPayload, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { useAdminMutation, useAdminQuery } from './shop-context';

type Resource = 'ORDER' | 'PRODUCT' | 'DRAFT_ORDER';

const QUERIES: Record<Resource, string> = {
  ORDER: OrderSavedSearchesQuery,
  PRODUCT: ProductSavedSearchesQuery,
  DRAFT_ORDER: DraftOrderSavedSearchesQuery,
};

/** The fields the core's refusals name. */
const FIELDS: Partial<Record<string, MessageKey>> = {
  name: 'savedSearches.fieldName',
  query: 'savedSearches.fieldQuery',
};

/** The longest name a saved search takes. */
const NAME_LENGTH = 40;

/** Runs a change of a saved search and says what went wrong, the core's words or the network's. */
function useChange() {
  const { t } = useLocale();
  const [problem, setProblem] = useState<string | null>(null);
  const change = async (run: () => Promise<{ userErrors: UserError[] }>): Promise<boolean> => {
    setProblem(null);
    try {
      const error = (await run()).userErrors[0];
      if (error) {
        const field = FIELDS[error.field?.at(-1) ?? ''];
        setProblem(field ? `${t(field)}: ${error.message}` : error.message);
      }
      return !error;
    } catch (failure) {
      setProblem(errorText(failure, t));
      return false;
    }
  };
  return { problem, change };
}

/** One saved search, renamed, its search changed, or deleted once asked. */
function EditSaved({ saved }: { saved: SavedSearch }) {
  const { t } = useLocale();
  const update = useAdminMutation<{ savedSearchUpdate: SavedSearchPayload }, { input: object }>(
    SavedSearchUpdateMutation,
  );
  const remove = useAdminMutation<
    { savedSearchDelete: { userErrors: UserError[] } },
    { input: { id: string } }
  >(SavedSearchDeleteMutation);
  const { problem, change } = useChange();
  const [name, setName] = useState(saved.name);
  const [query, setQuery] = useState(saved.query);
  const [asking, setAsking] = useState(false);
  const changed = name.trim() !== saved.name || query.trim() !== saved.query;

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    void change(async () => {
      const input = {
        id: saved.id,
        ...(name.trim() !== saved.name ? { name: name.trim() } : {}),
        ...(query.trim() !== saved.query ? { query: query.trim() } : {}),
      };
      return (await update.mutateAsync({ input })).savedSearchUpdate;
    });
  };

  return (
    <li className="flex flex-col gap-2 py-3">
      <form onSubmit={onSave} className="flex flex-col gap-2">
        <TextField
          label={t('savedSearches.nameOf', { name: saved.name })}
          dir="auto"
          maxLength={NAME_LENGTH}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label={t('savedSearches.queryOf', { name: saved.name })}
          dir="auto"
          maxLength={1000}
          required
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="secondary"
            disabled={!changed || !name.trim() || !query.trim()}
            busy={update.isPending}
            icon={<Save aria-hidden className="size-5" />}
          >
            {t('savedSearches.save')}
          </Button>
          {asking ? (
            <>
              <Button
                variant="destructive"
                busy={remove.isPending}
                onClick={() =>
                  void change(
                    async () =>
                      (await remove.mutateAsync({ input: { id: saved.id } })).savedSearchDelete,
                  ).then(() => setAsking(false))
                }
              >
                {t('savedSearches.deleteSure')}
              </Button>
              <Button variant="tertiary" onClick={() => setAsking(false)}>
                {t('action.back')}
              </Button>
            </>
          ) : (
            <Button
              variant="danger"
              icon={<Trash2 aria-hidden className="size-5" />}
              aria-label={t('savedSearches.delete', { name: saved.name })}
              onClick={() => setAsking(true)}
            />
          )}
        </div>
      </form>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/** The search shown, kept by a name for all the shop's staff. */
function SaveThis({ resource, query }: { resource: Resource; query: string }) {
  const { t } = useLocale();
  const create = useAdminMutation<{ savedSearchCreate: SavedSearchPayload }, { input: object }>(
    SavedSearchCreateMutation,
  );
  const { problem, change } = useChange();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    void change(
      async () =>
        (await create.mutateAsync({ input: { name: name.trim(), query, resourceType: resource } }))
          .savedSearchCreate,
    ).then((ok) => {
      if (ok) {
        setNaming(false);
        setName('');
      }
    });
  };

  if (!naming) {
    return (
      <Button
        variant="tertiary"
        icon={<BookmarkPlus aria-hidden className="size-5" />}
        onClick={() => setNaming(true)}
      >
        {t('savedSearches.saveThis')}
      </Button>
    );
  }
  return (
    <form onSubmit={onSave} className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label={t('savedSearches.name')}
          hint={t('savedSearches.nameHint', { query })}
          dir="auto"
          maxLength={NAME_LENGTH}
          required
          className="min-w-48 flex-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" busy={create.isPending} disabled={!name.trim()}>
          {t('savedSearches.save')}
        </Button>
        <Button variant="tertiary" onClick={() => setNaming(false)}>
          {t('action.back')}
        </Button>
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </form>
  );
}

/**
 * A list's saved searches (ORD-01, CAT-04): the searches its staff keep by name, one tap to run
 * each; the search shown saved by a name, and those saved renamed, changed and deleted by those
 * who change the list. Kept for all the shop's staff, as Shopify's saved views are.
 */
export function SavedSearches({
  resource,
  query,
  onApply,
  manages,
}: {
  resource: Resource;
  /** The search the list shows, if any. */
  query: string | undefined;
  onApply: (query: string | undefined) => void;
  manages: boolean;
}) {
  const { t } = useLocale();
  const saved = useAdminQuery<SavedSearchesData>(['savedSearches', resource], QUERIES[resource]);
  const [editing, setEditing] = useState(false);
  const searches = saved.data?.savedSearches.nodes ?? [];
  const current = query?.trim();
  const kept = current ? searches.some((each) => each.query === current) : true;

  if (searches.length === 0 && (!manages || !current)) return null;
  return (
    <section aria-label={t('savedSearches.title')} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Bookmark aria-hidden className="size-5 text-secondary" />
        {searches.map((each) => {
          const active = each.query === current;
          return (
            <button
              key={each.id}
              type="button"
              aria-pressed={active}
              title={each.query}
              onClick={() => onApply(active ? undefined : each.query)}
              className={`inline-flex min-h-10 items-center rounded-full border px-3 ${
                active
                  ? 'border-primary bg-primary text-on-primary'
                  : 'border-line bg-surface text-text'
              }`}
            >
              <span dir="auto">{each.name}</span>
            </button>
          );
        })}
        {manages && searches.length > 0 && (
          <Button
            variant="tertiary"
            aria-expanded={editing}
            icon={<Pencil aria-hidden className="size-5" />}
            onClick={() => setEditing((open) => !open)}
          >
            {t('savedSearches.edit')}
          </Button>
        )}
        {manages && !kept && current && <SaveThis resource={resource} query={current} />}
      </div>
      {editing && manages && (
        <ul className="divide-y divide-line rounded-control border border-line bg-surface px-3">
          {searches.map((each) => (
            <EditSaved key={`${each.id}-${each.name}-${each.query}`} saved={each} />
          ))}
        </ul>
      )}
    </section>
  );
}
