import { Plus, Trash2 } from 'lucide-react';
import type {
  CollectionRule,
  CollectionRuleColumn,
  CollectionRuleRelation,
  CollectionSortOrder,
} from '../api/types';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { SelectField } from '../settings/settings-form';
import { Button } from '../ui/button';
import { TextField } from '../ui/field';

const TEXT: readonly CollectionRuleRelation[] = [
  'EQUALS',
  'NOT_EQUALS',
  'CONTAINS',
  'NOT_CONTAINS',
  'STARTS_WITH',
  'ENDS_WITH',
];
const NUMBER: readonly CollectionRuleRelation[] = [
  'EQUALS',
  'NOT_EQUALS',
  'GREATER_THAN',
  'LESS_THAN',
];

/** The relations each column takes, as the core checks them. */
export const RELATIONS: Readonly<Record<CollectionRuleColumn, readonly CollectionRuleRelation[]>> =
  {
    TAG: ['EQUALS', 'NOT_EQUALS'],
    TITLE: TEXT,
    TYPE: TEXT,
    VENDOR: TEXT,
    VARIANT_TITLE: TEXT,
    VARIANT_PRICE: NUMBER,
    VARIANT_COMPARE_AT_PRICE: [...NUMBER, 'IS_SET', 'IS_NOT_SET'],
    VARIANT_WEIGHT: [...NUMBER, 'IS_SET', 'IS_NOT_SET'],
    IS_PRICE_REDUCED: ['IS_SET', 'IS_NOT_SET'],
  };

const COLUMNS = Object.keys(RELATIONS) as CollectionRuleColumn[];

/** The orders a collection's products can be shown in; by hand only for one made by hand. */
export function sortOrders(manual: boolean): CollectionSortOrder[] {
  return [
    ...(manual ? (['MANUAL'] as const) : []),
    'CREATED_DESC',
    'CREATED',
    'ALPHA_ASC',
    'ALPHA_DESC',
    'PRICE_ASC',
    'PRICE_DESC',
  ];
}

const takesCondition = (relation: CollectionRuleRelation) =>
  relation !== 'IS_SET' && relation !== 'IS_NOT_SET';

export const NEW_RULE: CollectionRule = { column: 'TAG', relation: 'EQUALS', condition: '' };

/** A rule as the core takes it: no condition where its relation needs none. */
export const ruleInput = (rule: CollectionRule) => ({
  column: rule.column,
  relation: rule.relation,
  condition: takesCondition(rule.relation) ? rule.condition.trim() : '',
});

/** Whether every rule that needs a condition has one. */
export const rulesComplete = (rules: readonly CollectionRule[]) =>
  rules.length > 0 &&
  rules.every((rule) => !takesCondition(rule.relation) || rule.condition.trim() !== '');

/**
 * A collection's rules: each a column, how it compares and what to; products match all of them,
 * or any one.
 */
export function RulesEditor({
  rules,
  any,
  onChange,
}: {
  rules: readonly CollectionRule[];
  any: boolean;
  onChange: (rules: CollectionRule[], any: boolean) => void;
}) {
  const { t } = useLocale();
  const set = (index: number, next: Partial<CollectionRule>) =>
    onChange(
      rules.map((rule, at) => {
        if (at !== index) return rule;
        const merged = { ...rule, ...next };
        // A column that does not take the relation chosen falls back to its first.
        if (!RELATIONS[merged.column].includes(merged.relation)) {
          merged.relation = RELATIONS[merged.column][0]!;
        }
        return merged;
      }),
      any,
    );

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 font-medium">{t('collection.match')}</legend>
        {[false, true].map((each) => (
          <label key={String(each)} className="flex min-h-10 items-center gap-2">
            <input
              type="radio"
              name="match"
              checked={any === each}
              onChange={() => onChange([...rules], each)}
              className="size-5 accent-[var(--hatti-color-primary)]"
            />
            {t(each ? 'collection.matchAny' : 'collection.matchAll')}
          </label>
        ))}
      </fieldset>
      <ol className="flex flex-col gap-3">
        {rules.map((rule, index) => (
          <li
            key={index}
            className="flex flex-wrap items-end gap-2 rounded-control border border-line p-3"
          >
            <SelectField
              label={t('collection.ruleColumn', { number: index + 1 })}
              value={rule.column}
              options={COLUMNS.map((column) => ({
                value: column,
                label: t(`collection.column.${column}` as MessageKey),
              }))}
              onChange={(column) => set(index, { column })}
            />
            <SelectField
              label={t('collection.ruleRelation', { number: index + 1 })}
              value={rule.relation}
              options={RELATIONS[rule.column].map((relation) => ({
                value: relation,
                label: t(`collection.relation.${relation}` as MessageKey),
              }))}
              onChange={(relation) => set(index, { relation })}
            />
            {takesCondition(rule.relation) && (
              <TextField
                label={t('collection.ruleCondition', { number: index + 1 })}
                dir="auto"
                className="w-40"
                value={rule.condition}
                onChange={(event) => set(index, { condition: event.target.value })}
              />
            )}
            {rules.length > 1 && (
              <Button
                variant="danger"
                aria-label={t('collection.ruleRemove', { number: index + 1 })}
                icon={<Trash2 aria-hidden className="size-5" />}
                onClick={() =>
                  onChange(
                    rules.filter((_, at) => at !== index),
                    any,
                  )
                }
              />
            )}
          </li>
        ))}
      </ol>
      <Button
        variant="secondary"
        className="self-start"
        icon={<Plus aria-hidden className="size-5" />}
        onClick={() => onChange([...rules, NEW_RULE], any)}
      >
        {t('collection.ruleAdd')}
      </Button>
    </div>
  );
}
