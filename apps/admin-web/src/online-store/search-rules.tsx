import { useSearch } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, EyeOff, Pencil, Pin, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  SearchRuleDeleteMutation,
  SearchRuleSetMutation,
  SearchRulesQuery,
} from '../api/operations';
import type {
  SearchRuleDeleteData,
  SearchRuleSetData,
  SearchRulesData,
  SearchRuleValue,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { Problems } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { ProductFinder } from './link-page';

/** What the core takes for a term (ADR-692). */
export const MOST_PINNED = 10;
export const MOST_HIDDEN = 50;

interface Chosen {
  id: string;
  title: string;
}

/** The core's words for what it refused, a product named where it is one (ADR-692). */
export function ruleProblems(
  errors: readonly UserError[],
  pinned: readonly Chosen[],
  hidden: readonly Chosen[],
): { query: string | null; rest: string[] } {
  let query: string | null = null;
  const rest: string[] = [];
  for (const error of errors) {
    const [field, at] = error.field ?? [];
    const list =
      field === 'pinnedProductIds' ? pinned : field === 'hiddenProductIds' ? hidden : null;
    const product = list && at !== undefined ? list[Number(at)] : undefined;
    if (field === 'query') query = query ? `${query} ${error.message}` : error.message;
    else rest.push(product ? `${product.title}: ${error.message}` : error.message);
  }
  return { query, rest };
}

/** A list of products chosen for the term, each removed, and in order where it keeps one. */
function ChosenList({
  label,
  products,
  ordered,
  onChange,
}: {
  label: string;
  products: Chosen[];
  ordered: boolean;
  onChange: (products: Chosen[]) => void;
}) {
  const { t } = useLocale();
  const move = (index: number, by: number) => {
    const next = [...products];
    const [taken] = next.splice(index, 1);
    next.splice(index + by, 0, taken!);
    onChange(next);
  };
  if (products.length === 0) return <p className="text-secondary">{t('searchRules.noneChosen')}</p>;
  const List = ordered ? 'ol' : 'ul';
  return (
    <List
      aria-label={label}
      className="flex flex-col divide-y divide-line rounded-control border border-line"
    >
      {products.map((each, index) => (
        <li key={each.id} className="flex items-center gap-1 px-3 py-2">
          <span className="min-w-0 flex-1" dir="auto">
            {each.title}
          </span>
          {ordered && (
            <>
              <Button
                variant="tertiary"
                aria-label={t('pairings.moveUp', { title: each.title })}
                disabled={index === 0}
                icon={<ArrowUp aria-hidden className="size-5" />}
                onClick={() => move(index, -1)}
              />
              <Button
                variant="tertiary"
                aria-label={t('pairings.moveDown', { title: each.title })}
                disabled={index === products.length - 1}
                icon={<ArrowDown aria-hidden className="size-5" />}
                onClick={() => move(index, 1)}
              />
            </>
          )}
          <Button
            variant="tertiary"
            aria-label={t('pairings.remove', { title: each.title })}
            icon={<Trash2 aria-hidden className="size-5" />}
            onClick={() => onChange(products.filter((_, at) => at !== index))}
          />
        </li>
      ))}
    </List>
  );
}

/**
 * A term's rule, new or kept: what to pin to the top of its search, in order, and what to hide,
 * saved together.
 */
function RuleForm({
  rule,
  term,
  onDone,
}: {
  rule?: SearchRuleValue;
  term?: string;
  onDone: (saved: boolean) => void;
}) {
  const { t } = useLocale();
  const set = useAdminMutation<
    SearchRuleSetData,
    { query: string; pinnedProductIds: string[]; hiddenProductIds: string[] }
  >(SearchRuleSetMutation);
  const [query, setQuery] = useState(rule?.query ?? term ?? '');
  const [pinned, setPinned] = useState<Chosen[]>(rule?.pinnedProducts ?? []);
  const [hidden, setHidden] = useState<Chosen[]>(rule?.hiddenProducts ?? []);
  const [picking, setPicking] = useState<'pin' | 'hide' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const onAdd = (id: string, title: string) => {
    if ([...pinned, ...hidden].some((each) => each.id === id)) {
      setNote(t('searchRules.already', { title }));
    } else if (picking === 'pin' && pinned.length >= MOST_PINNED) {
      setNote(t('searchRules.mostPinned', { most: MOST_PINNED }));
    } else if (picking === 'hide' && hidden.length >= MOST_HIDDEN) {
      setNote(t('searchRules.mostHidden', { most: MOST_HIDDEN }));
    } else {
      setNote(null);
      if (picking === 'pin') setPinned([...pinned, { id, title }]);
      else setHidden([...hidden, { id, title }]);
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setQueryError(null);
    setProblems([]);
    try {
      const { searchRuleSet: result } = await set.mutateAsync({
        query,
        pinnedProductIds: pinned.map((each) => each.id),
        hiddenProductIds: hidden.map((each) => each.id),
      });
      if (result.userErrors.length > 0) {
        const said = ruleProblems(result.userErrors, pinned, hidden);
        setQueryError(said.query);
        setProblems(said.rest);
        return;
      }
      onDone(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const finder = (which: 'pin' | 'hide') =>
    picking === which ? (
      <ProductFinder onAdd={onAdd} note={note} />
    ) : (
      <Button
        variant="secondary"
        className="self-start"
        icon={
          which === 'pin' ? (
            <Pin aria-hidden className="size-5" />
          ) : (
            <EyeOff aria-hidden className="size-5" />
          )
        }
        onClick={() => {
          setNote(null);
          setPicking(which);
        }}
      >
        {t(which === 'pin' ? 'searchRules.pin' : 'searchRules.hide')}
      </Button>
    );

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection
        title={rule ? t('searchRules.editTitle', { query: rule.query }) : t('searchRules.newTitle')}
      >
        <TextField
          label={t('searchRules.query')}
          hint={t('searchRules.queryHint')}
          dir="auto"
          required
          maxLength={100}
          value={query}
          error={queryError ?? undefined}
          autoFocus={!rule}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex flex-col gap-2">
          <h3 className="font-medium">{t('searchRules.pinned')}</h3>
          <p className="text-secondary">{t('searchRules.pinnedHint', { most: MOST_PINNED })}</p>
          <ChosenList
            label={t('searchRules.pinned')}
            products={pinned}
            ordered
            onChange={setPinned}
          />
          {finder('pin')}
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-medium">{t('searchRules.hidden')}</h3>
          <p className="text-secondary">{t('searchRules.hiddenHint', { most: MOST_HIDDEN })}</p>
          <ChosenList
            label={t('searchRules.hidden')}
            products={hidden}
            ordered={false}
            onChange={setHidden}
          />
          {finder('hide')}
        </div>
        <Problems problems={problems} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={set.isPending}>
            {t('searchRules.save')}
          </Button>
          <Button variant="secondary" onClick={() => onDone(false)}>
            {t('searchRules.cancel')}
          </Button>
        </div>
      </FormSection>
    </form>
  );
}

/** The shop's rules, each opened to change or taken away. */
function RulesList({
  rules,
  onEdit,
}: {
  rules: SearchRuleValue[];
  onEdit: (rule: SearchRuleValue) => void;
}) {
  const { t } = useLocale();
  const remove = useAdminMutation<SearchRuleDeleteData, { id: string }>(SearchRuleDeleteMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const onRemove = async (rule: SearchRuleValue) => {
    setProblem(null);
    try {
      const { searchRuleDelete } = await remove.mutateAsync({ id: rule.id });
      const error = searchRuleDelete.userErrors[0];
      if (error) setProblem(error.message);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };
  if (rules.length === 0) return <p className="text-secondary">{t('searchRules.none')}</p>;
  return (
    <>
      <ul
        aria-label={t('searchRules.title')}
        className="flex flex-col divide-y divide-line rounded-control border border-line"
      >
        {rules.map((rule) => (
          <li key={rule.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium" dir="auto">
                {rule.query}
              </span>
              <span className="text-secondary">
                {t('searchRules.summary', {
                  pinned: rule.pinnedProducts.length,
                  hidden: rule.hiddenProducts.length,
                })}
              </span>
            </div>
            <Button
              variant="tertiary"
              aria-label={t('searchRules.edit', { query: rule.query })}
              icon={<Pencil aria-hidden className="size-5" />}
              onClick={() => onEdit(rule)}
            >
              {t('searchRules.editShort')}
            </Button>
            <Button
              variant="danger"
              aria-label={t('searchRules.remove', { query: rule.query })}
              icon={<Trash2 aria-hidden className="size-5" />}
              onClick={() => void onRemove(rule)}
            >
              {t('synonyms.removeShort')}
            </Button>
          </li>
        ))}
      </ul>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </>
  );
}

/**
 * What the shop's search shows first, or leaves out, term by term (SRC-04, ADR-693), for those
 * who change products: its Eid edit first for "eid", last season's left out. A top search the
 * analytics page offers opens with its words as a new term's.
 */
export function SearchRulesTab() {
  const { t } = useLocale();
  const search = useSearch({ from: '/$shopId/online-store' });
  const query = useAdminQuery<SearchRulesData>(['searchRules'], SearchRulesQuery);
  // What the form opens: a kept rule, a new one (begun with a search's words), or none.
  const [open, setOpen] = useState<{ rule?: SearchRuleValue; term?: string } | null>(() =>
    search.term ? { term: search.term } : null,
  );
  const [saved, setSaved] = useState(false);
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const rules = query.data.searchRules;
  // A search with a rule already opens that rule.
  const kept =
    open?.term !== undefined
      ? rules.find((rule) => rule.query.toLowerCase() === open.term!.toLowerCase())
      : undefined;
  return (
    <div className="flex flex-col gap-4">
      <FormSection title={t('searchRules.title')} hint={t('searchRules.intro')}>
        <RulesList
          rules={rules}
          onEdit={(rule) => {
            setSaved(false);
            setOpen({ rule });
          }}
        />
        {saved && <Alert tone="success">{t('storefront.saved')}</Alert>}
        {!open && (
          <Button
            variant="secondary"
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setSaved(false);
              setOpen({});
            }}
          >
            {t('searchRules.add')}
          </Button>
        )}
      </FormSection>
      {open && (
        <RuleForm
          key={open.rule?.id ?? kept?.id ?? 'new'}
          rule={open.rule ?? kept}
          term={open.term}
          onDone={(done) => {
            setSaved(done);
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}
