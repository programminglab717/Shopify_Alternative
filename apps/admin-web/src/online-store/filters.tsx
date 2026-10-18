import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { OnlineStoreFiltersQuery, OnlineStoreFiltersUpdateMutation } from '../api/operations';
import type {
  OnlineStoreFilters,
  OnlineStoreFiltersData,
  OnlineStoreFiltersUpdateData,
  StorefrontFilter,
  StorefrontFilterInput,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { Problems } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** What the core takes: up to 25 filters, each label up to 60 characters (ADR-568). */
const LIMITS = { filters: 25, label: 60 } as const;

/** The metafield types the core lets a filter narrow by, in the merchant's words. */
const FIELD_TYPES: Record<string, MessageKey> = {
  single_line_text_field: 'customData.type.single_line_text_field',
  'list.single_line_text_field': 'customData.type.list.single_line_text_field',
  boolean: 'customData.type.boolean',
};

/** The parts of the add menu, each the kinds of filter it lists. */
const GROUPS: { label: MessageKey; holds: (filter: StorefrontFilter) => boolean }[] = [
  { label: 'filters.builtIn', holds: (filter) => !metafield(filter) && filter.kind !== 'OPTION' },
  { label: 'filters.options', holds: (filter) => filter.kind === 'OPTION' },
  { label: 'filters.productFields', holds: (filter) => filter.kind === 'PRODUCT_METAFIELD' },
  { label: 'filters.variantFields', holds: (filter) => filter.kind === 'VARIANT_METAFIELD' },
];

interface FilterDraft {
  key: number;
  filter: StorefrontFilter;
  label: string;
  labelUr: string;
}

/** What the core said of one filter: of the filter itself, or of one of its labels. */
interface RowErrors {
  row?: string;
  label?: string;
  labelUr?: string;
}

function metafield(filter: StorefrontFilter): boolean {
  return filter.kind === 'PRODUCT_METAFIELD' || filter.kind === 'VARIANT_METAFIELD';
}

/** Which filter it is, whatever its labels: an option's name matched whatever its case. */
function identity(filter: StorefrontFilter): string {
  const key = filter.kind === 'OPTION' ? filter.key?.toLowerCase() : filter.key;
  return `${filter.kind}:${key ?? ''}`;
}

/** Those the pages show while the shop chooses none: all but the metafields', in their order. */
function defaultFilters(available: StorefrontFilter[]): StorefrontFilter[] {
  return available.filter((filter) => !metafield(filter)).slice(0, LIMITS.filters);
}

/** A filter as the core takes it: blank labels left out, for the default words. */
function inputOf(filter: StorefrontFilter, label: string, labelUr: string): StorefrontFilterInput {
  return {
    kind: filter.kind,
    ...(filter.key !== null && { key: filter.key }),
    ...(label.trim() && { label: label.trim() }),
    ...(labelUr.trim() && { labelUr: labelUr.trim() }),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `list` with the item at `index` moved by `step`. */
function moved<T>(list: T[], index: number, step: number): T[] {
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(index + step, 0, item!);
  return next;
}

/** What a filter is, below its name: its kind, and a metafield's key and type. */
function FilterKind({ filter }: { filter: StorefrontFilter }) {
  const { t } = useLocale();
  const type = filter.metafieldType;
  return (
    <span className="text-secondary">
      {t(`filters.kind.${filter.kind}`)}
      {metafield(filter) && (
        <>
          {' · '}
          <code dir="ltr">{filter.key}</code>
          {type && ` · ${FIELD_TYPES[type] ? t(FIELD_TYPES[type]) : type}`}
        </>
      )}
    </span>
  );
}

/** One chosen filter: its name and kind, its own words in English and Urdu, its place. */
function FilterRow({
  draft,
  number,
  last,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  draft: FilterDraft;
  number: number;
  last: boolean;
  errors: RowErrors | undefined;
  onChange: (change: Partial<Pick<FilterDraft, 'label' | 'labelUr'>>) => void;
  onMove: (step: number) => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  const { filter } = draft;
  const name = filter.defaultLabel;
  return (
    <li className="flex flex-col gap-2 rounded-control border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span dir="auto" className="font-medium">
            {name}
          </span>
          <FilterKind filter={filter} />
          {metafield(filter) && !filter.metafieldType && (
            <span className="text-warning">{t('filters.fieldGone')}</span>
          )}
        </span>
        <span className="flex gap-1">
          <Button
            variant="tertiary"
            aria-label={t('filters.moveUp', { name })}
            disabled={number === 1}
            icon={<ArrowUp aria-hidden className="size-5" />}
            onClick={() => onMove(-1)}
          />
          <Button
            variant="tertiary"
            aria-label={t('filters.moveDown', { name })}
            disabled={last}
            icon={<ArrowDown aria-hidden className="size-5" />}
            onClick={() => onMove(1)}
          />
          <Button
            variant="danger"
            aria-label={t('filters.remove', { name })}
            icon={<Trash2 aria-hidden className="size-5" />}
            onClick={onRemove}
          />
        </span>
      </div>
      {errors?.row && <p className="text-danger">{errors.row}</p>}
      <div className="grid gap-2 md:grid-cols-2 [&>*]:min-w-0">
        <TextField
          label={t('filters.label', { number })}
          dir="auto"
          maxLength={LIMITS.label}
          placeholder={name}
          error={errors?.label}
          value={draft.label}
          onChange={(event) => onChange({ label: event.target.value })}
        />
        <TextField
          label={t('filters.labelUr', { number })}
          dir="auto"
          maxLength={LIMITS.label}
          placeholder={draft.label.trim() || name}
          error={errors?.labelUr}
          value={draft.labelUr}
          onChange={(event) => onChange({ labelUr: event.target.value })}
        />
      </div>
    </li>
  );
}

/** A filter the shop could choose and has not, picked from a menu and added at the end. */
function AddFilter({
  choices,
  full,
  onAdd,
}: {
  choices: StorefrontFilter[];
  full: boolean;
  onAdd: (filter: StorefrontFilter) => void;
}) {
  const { t } = useLocale();
  const id = useId();
  const [picked, setPicked] = useState('');
  if (choices.length === 0 && !full) {
    return <p className="text-secondary">{t('filters.allAdded')}</p>;
  }
  const chosen = choices.find((filter) => identity(filter) === picked) ?? choices[0];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={id} className="font-medium">
            {t('filters.toAdd')}
          </label>
          <select
            id={id}
            value={chosen ? identity(chosen) : ''}
            disabled={full}
            onChange={(event) => setPicked(event.target.value)}
            className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
          >
            {GROUPS.map((group) => {
              const held = choices.filter(group.holds);
              if (held.length === 0) return null;
              return (
                <optgroup key={group.label} label={t(group.label)}>
                  {held.map((filter) => (
                    <option key={identity(filter)} value={identity(filter)}>
                      {metafield(filter)
                        ? `${filter.defaultLabel} (${filter.key})`
                        : filter.defaultLabel}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </div>
        <Button
          variant="secondary"
          icon={<Plus aria-hidden className="size-5" />}
          disabled={full || !chosen}
          onClick={() => {
            if (!chosen) return;
            onAdd(chosen);
            setPicked('');
          }}
        >
          {t('filters.add')}
        </Button>
      </div>
      {full && <p className="text-secondary">{t('filters.full', { count: LIMITS.filters })}</p>}
    </div>
  );
}

/** Every filter in the platform's order, or the shop's own list, saved whole. */
function FiltersForm({ filters }: { filters: OnlineStoreFilters }) {
  const { t } = useLocale();
  const update = useAdminMutation<
    OnlineStoreFiltersUpdateData,
    { input: { filters: StorefrontFilterInput[] | null } }
  >(OnlineStoreFiltersUpdateMutation);
  const next = useRef(0);
  const draftsOf = (list: StorefrontFilter[]): FilterDraft[] =>
    list.map((filter) => ({
      key: (next.current += 1),
      filter,
      label: filter.label ?? '',
      labelUr: filter.labelUr ?? '',
    }));
  const [kept, setKept] = useState(filters);
  const [choosing, setChoosing] = useState(filters.filters !== null);
  // Choosing starts from what the pages show now: the shop's list, or the platform's.
  const [drafts, setDrafts] = useState(() =>
    draftsOf(filters.filters ?? defaultFilters(filters.availableFilters)),
  );
  const [rowErrors, setRowErrors] = useState<Record<number, RowErrors>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const input = choosing
    ? drafts.map((draft) => inputOf(draft.filter, draft.label, draft.labelUr))
    : null;
  const keptInput =
    kept.filters?.map((filter) => inputOf(filter, filter.label ?? '', filter.labelUr ?? '')) ??
    null;
  const changed = !same(input, keptInput);
  const taken = new Set(drafts.map((draft) => identity(draft.filter)));
  const choices = kept.availableFilters.filter((filter) => !taken.has(identity(filter)));
  const shownByDefault = defaultFilters(kept.availableFilters);

  const setDraft = (index: number, change: Partial<FilterDraft>) =>
    setDrafts((all) => all.map((each, at) => (at === index ? { ...each, ...change } : each)));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setProblems([]);
    setRowErrors({});
    setSaved(false);
    const sentDrafts = drafts;
    try {
      const { onlineStoreFiltersUpdate: result } = await update.mutateAsync({
        input: { filters: input },
      });
      if (result.userErrors.length > 0) {
        const byRow: Record<number, RowErrors> = {};
        const rest: string[] = [];
        for (const error of result.userErrors) {
          const [, list, at, part] = error.field ?? [];
          const draft = list === 'filters' ? sentDrafts[Number(at)] : undefined;
          if (draft && at !== undefined && /^\d+$/.test(at)) {
            const slot = part === 'label' || part === 'labelUr' ? part : 'row';
            const row = (byRow[draft.key] ??= {});
            row[slot] = row[slot] ? `${row[slot]} ${error.message}` : error.message;
          } else {
            rest.push(error.message);
          }
        }
        setRowErrors(byRow);
        setProblems(rest);
        return;
      }
      const now = result.onlineStoreFilters!;
      setKept(now);
      setChoosing(now.filters !== null);
      setDrafts(draftsOf(now.filters ?? defaultFilters(now.availableFilters)));
      setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <FormSection title={t('filters.title')} hint={t('filters.intro')}>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">{t('filters.which')}</legend>
          {[false, true].map((each) => (
            <label key={String(each)} className="flex min-h-12 cursor-pointer items-start gap-3">
              <input
                type="radio"
                name="filters-choosing"
                checked={choosing === each}
                onChange={() => setChoosing(each)}
                className="mt-1 size-5 shrink-0 accent-[var(--hatti-color-primary)]"
              />
              <span className="flex flex-col">
                <span className="font-medium">{t(each ? 'filters.choose' : 'filters.every')}</span>
                <span className="text-secondary">
                  {t(each ? 'filters.chooseHint' : 'filters.everyHint')}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {!choosing && (
          <ol
            aria-label={t('filters.every')}
            className="flex flex-col divide-y divide-line rounded-control border border-line"
          >
            {shownByDefault.map((filter) => (
              <li key={identity(filter)} className="flex flex-col px-3 py-2">
                <span dir="auto" className="font-medium">
                  {filter.defaultLabel}
                </span>
                <FilterKind filter={filter} />
              </li>
            ))}
          </ol>
        )}

        {choosing && (
          <>
            {drafts.length > 0 ? (
              <ol aria-label={t('filters.chosen')} className="flex flex-col gap-2">
                {drafts.map((draft, index) => (
                  <FilterRow
                    key={draft.key}
                    draft={draft}
                    number={index + 1}
                    last={index === drafts.length - 1}
                    errors={rowErrors[draft.key]}
                    onChange={(change) => setDraft(index, change)}
                    onMove={(step) => setDrafts((all) => moved(all, index, step))}
                    onRemove={() => setDrafts((all) => all.filter((_, at) => at !== index))}
                  />
                ))}
              </ol>
            ) : (
              <Alert tone="warning">{t('filters.none')}</Alert>
            )}
            <AddFilter
              choices={choices}
              full={drafts.length >= LIMITS.filters}
              onAdd={(filter) =>
                setDrafts((all) => [
                  ...all,
                  { key: (next.current += 1), filter, label: '', labelUr: '' },
                ])
              }
            />
          </>
        )}

        <Problems problems={problems} />
        {saved && !changed && <Alert tone="success">{t('storefront.saved')}</Alert>}
        <Button type="submit" className="self-start" busy={update.isPending} disabled={!changed}>
          {t('filters.save')}
        </Button>
      </FormSection>
    </form>
  );
}

/**
 * The storefront's filters (SRC-03, ADR-568), for owners and managers: every one in the
 * platform's order, or those the shop chooses, in its order and words, up to 25.
 */
export function FiltersTab() {
  const { t } = useLocale();
  const query = useAdminQuery<OnlineStoreFiltersData>(
    ['onlineStoreFilters'],
    OnlineStoreFiltersQuery,
  );
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  return <FiltersForm filters={query.data.onlineStoreFilters} />;
}
