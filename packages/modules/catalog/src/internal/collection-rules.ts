import { fromMajor, type CurrencyCode } from '@hatti/money';
import { sql, type SQL } from 'drizzle-orm';
import type { CollectionRuleValue } from './schema.js';

/**
 * Smart collection rules, like Shopify's: a product joins the collection when all rules match, or
 * any rule when the collection is disjunctive. Rules compile to SQL over `p` (catalog.products), so
 * membership can be recomputed for one product or a whole shop in one statement.
 */
export const RULE_COLUMNS = [
  'title',
  'type',
  'vendor',
  'tag',
  'variant_title',
  'variant_price',
  'variant_compare_at_price',
  'variant_weight',
  'is_price_reduced',
] as const;
export type RuleColumn = (typeof RULE_COLUMNS)[number];

export const RULE_RELATIONS = [
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'starts_with',
  'ends_with',
  'contains',
  'not_contains',
  'is_set',
  'is_not_set',
] as const;
export type RuleRelation = (typeof RULE_RELATIONS)[number];

const TEXT_RELATIONS: readonly RuleRelation[] = [
  'equals',
  'not_equals',
  'starts_with',
  'ends_with',
  'contains',
  'not_contains',
];
const NUMBER_RELATIONS: readonly RuleRelation[] = [
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
];

/** Which relations each column accepts. */
export const RELATIONS_BY_COLUMN: Readonly<Record<RuleColumn, readonly RuleRelation[]>> = {
  title: TEXT_RELATIONS,
  type: TEXT_RELATIONS,
  vendor: TEXT_RELATIONS,
  tag: ['equals', 'not_equals'],
  variant_title: TEXT_RELATIONS,
  variant_price: NUMBER_RELATIONS,
  variant_compare_at_price: [...NUMBER_RELATIONS, 'is_set', 'is_not_set'],
  variant_weight: [...NUMBER_RELATIONS, 'is_set', 'is_not_set'],
  is_price_reduced: ['is_set', 'is_not_set'],
};

export const MAX_RULES = 60;
const MAX_CONDITION_LENGTH = 255;

export interface RuleProblem {
  /** Index of the rule, and the field at fault. */
  index: number;
  field: 'column' | 'relation' | 'condition';
  message: string;
}

/** A rule checked and ready to compile. Amounts are in minor units, weights in grams. */
export type CheckedRule =
  | { column: 'title' | 'type' | 'vendor' | 'variant_title'; relation: RuleRelation; text: string }
  | { column: 'tag'; relation: 'equals' | 'not_equals'; text: string }
  | {
      column: 'variant_price' | 'variant_compare_at_price' | 'variant_weight';
      relation: RuleRelation;
      amount: bigint | null;
    }
  | { column: 'is_price_reduced'; relation: 'is_set' | 'is_not_set' };

function isColumn(value: string): value is RuleColumn {
  return (RULE_COLUMNS as readonly string[]).includes(value);
}

/** Validates stored or submitted rules. Returns the problems, or the checked rules. */
export function checkRules(
  rules: readonly CollectionRuleValue[],
  currency: CurrencyCode,
): { ok: true; rules: CheckedRule[] } | { ok: false; problems: RuleProblem[] } {
  const problems: RuleProblem[] = [];
  const checked: CheckedRule[] = [];
  rules.forEach((rule, index) => {
    if (!isColumn(rule.column)) {
      problems.push({ index, field: 'column', message: `Unknown rule column ${rule.column}` });
      return;
    }
    const relation = rule.relation as RuleRelation;
    if (!RELATIONS_BY_COLUMN[rule.column].includes(relation)) {
      problems.push({
        index,
        field: 'relation',
        message: `${rule.column} rules can't use ${rule.relation}`,
      });
      return;
    }
    const condition = rule.condition.trim();
    const needsCondition = relation !== 'is_set' && relation !== 'is_not_set';
    if (needsCondition && condition.length === 0) {
      problems.push({ index, field: 'condition', message: "Condition can't be blank" });
      return;
    }
    if (condition.length > MAX_CONDITION_LENGTH) {
      problems.push({
        index,
        field: 'condition',
        message: `Condition is too long (maximum is ${MAX_CONDITION_LENGTH} characters)`,
      });
      return;
    }
    switch (rule.column) {
      case 'title':
      case 'type':
      case 'vendor':
      case 'variant_title':
        checked.push({ column: rule.column, relation, text: condition });
        return;
      case 'tag':
        checked.push({
          column: 'tag',
          relation: relation as 'equals' | 'not_equals',
          text: condition,
        });
        return;
      case 'is_price_reduced':
        checked.push({ column: 'is_price_reduced', relation: relation as 'is_set' | 'is_not_set' });
        return;
      case 'variant_price':
      case 'variant_compare_at_price':
      case 'variant_weight': {
        if (!needsCondition) {
          checked.push({ column: rule.column, relation, amount: null });
          return;
        }
        const amount = parseAmount(rule.column, condition, currency);
        if (amount === null) {
          problems.push({
            index,
            field: 'condition',
            message:
              rule.column === 'variant_weight'
                ? 'Condition must be a weight in grams, like 500'
                : 'Condition must be an amount, like 2499 or 2499.50',
          });
          return;
        }
        checked.push({ column: rule.column, relation, amount });
      }
    }
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, rules: checked };
}

function parseAmount(column: RuleColumn, condition: string, currency: CurrencyCode): bigint | null {
  if (column === 'variant_weight') {
    return /^\d{1,9}$/.test(condition) ? BigInt(condition) : null;
  }
  try {
    const amount = fromMajor(condition, currency).amount;
    return amount >= 0n ? amount : null;
  } catch {
    return null;
  }
}

function textMatch(expression: SQL, relation: RuleRelation, text: string): SQL {
  const needle = text.toLowerCase();
  switch (relation) {
    case 'equals':
      return sql`lower(${expression}) = ${needle}`;
    case 'not_equals':
      return sql`lower(${expression}) <> ${needle}`;
    case 'starts_with':
      return sql`starts_with(lower(${expression}), ${needle})`;
    case 'ends_with':
      return sql`right(lower(${expression}), ${needle.length}) = ${needle}`;
    case 'contains':
      return sql`strpos(lower(${expression}), ${needle}) > 0`;
    case 'not_contains':
      return sql`strpos(lower(${expression}), ${needle}) = 0`;
    default:
      throw new Error(`Unsupported text relation ${relation}`);
  }
}

function numberMatch(expression: SQL, relation: RuleRelation, amount: bigint | null): SQL {
  switch (relation) {
    case 'equals':
      return sql`${expression} = ${amount}`;
    case 'not_equals':
      return sql`${expression} <> ${amount}`;
    case 'greater_than':
      return sql`${expression} > ${amount}`;
    case 'less_than':
      return sql`${expression} < ${amount}`;
    case 'is_set':
      return sql`${expression} IS NOT NULL`;
    default:
      throw new Error(`Unsupported number relation ${relation}`);
  }
}

/** A condition on the product's variants: true when any variant matches. */
function anyVariant(condition: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM catalog.variants v
                      WHERE v.shop_id = p.shop_id AND v.product_id = p.id AND ${condition})`;
}

function compileRule(rule: CheckedRule): SQL {
  switch (rule.column) {
    case 'title':
      return textMatch(sql`p.title`, rule.relation, rule.text);
    case 'type':
      return textMatch(sql`coalesce(p.product_type, '')`, rule.relation, rule.text);
    case 'vendor':
      return textMatch(sql`coalesce(p.vendor, '')`, rule.relation, rule.text);
    case 'tag': {
      const tagged = sql`EXISTS (SELECT 1 FROM unnest(p.tags) AS t(tag)
                                  WHERE lower(t.tag) = ${rule.text.toLowerCase()})`;
      return rule.relation === 'equals' ? tagged : sql`NOT ${tagged}`;
    }
    case 'variant_title':
      return anyVariant(textMatch(sql`v.title`, rule.relation, rule.text));
    case 'variant_price':
    case 'variant_compare_at_price':
    case 'variant_weight': {
      const column =
        rule.column === 'variant_price'
          ? sql`v.price`
          : rule.column === 'variant_compare_at_price'
            ? sql`v.compare_at_price`
            : sql`v.weight_grams`;
      // "Not equal" and "not set" hold when no variant is equal or set.
      if (rule.relation === 'not_equals')
        return sql`NOT ${anyVariant(sql`${column} = ${rule.amount}`)}`;
      if (rule.relation === 'is_not_set') return sql`NOT ${anyVariant(sql`${column} IS NOT NULL`)}`;
      return anyVariant(numberMatch(column, rule.relation, rule.amount));
    }
    case 'is_price_reduced': {
      const reduced = anyVariant(sql`v.compare_at_price > v.price`);
      return rule.relation === 'is_set' ? reduced : sql`NOT ${reduced}`;
    }
  }
}

/** The SQL condition a product row `p` must meet to belong to the collection. */
export function compileRules(rules: readonly CheckedRule[], disjunctive: boolean): SQL {
  if (rules.length === 0) return sql`false`;
  const parts = rules.map((rule) => sql`(${compileRule(rule)})`);
  return sql.join(parts, disjunctive ? sql` OR ` : sql` AND `);
}
