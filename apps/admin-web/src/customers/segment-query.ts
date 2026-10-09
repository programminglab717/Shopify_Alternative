import type { SegmentFieldType } from '../api/types';

/**
 * A segment's conditions as the admin builds them (CUS-03), and the core's query language they
 * are written in: `number_of_orders >= 2 AND city IN (Lahore, 'Rahim Yar Khan')`. Each kind of
 * field takes the conditions a merchant asks for in words; a query of others, or of AND and OR
 * mixed, NOT or parentheses, is kept and edited as its text.
 */

/** How a condition compares: as the core writes it, or, for dates, days back from today. */
export type ConditionOp =
  | '>='
  | '<='
  | '='
  | '>'
  | '<'
  | '!='
  | 'IN'
  | 'CONTAINS'
  | 'NOT CONTAINS'
  | 'WITHIN_DAYS'
  | 'BEFORE_DAYS';

export interface Condition {
  field: string;
  op: ConditionOp;
  value: string;
}

export type Join = 'AND' | 'OR';

/** What each kind of field is asked about, the first its default. */
export const OPS_BY_TYPE: Record<SegmentFieldType, readonly ConditionOp[]> = {
  NUMBER: ['>=', '<=', '=', '>', '<', '!='],
  MONEY: ['>=', '<=', '>', '<'],
  DATE: ['WITHIN_DAYS', 'BEFORE_DAYS'],
  TEXT: ['=', '!=', 'IN'],
  TEXT_LIST: ['CONTAINS', 'NOT CONTAINS'],
  BOOLEAN: ['='],
};

/** The answers a consent field takes, as the core spells them. */
export const CONSENT_STATES = ['subscribed', 'not_subscribed', 'unsubscribed'] as const;

export const isConsentField = (field: string) => field.endsWith('_subscription_status');

/** A value as the query writes it: a bare word where it is one, else quoted, quotes doubled. */
export function literal(value: string): string {
  const text = value.trim();
  return /^[\p{L}\p{N}_.-]+$/u.test(text) ? text : `'${text.replace(/'/g, "''")}'`;
}

/** One condition in the query language, or null while it is not filled in. */
export function conditionText(condition: Condition): string | null {
  const { field, op } = condition;
  const value = condition.value.trim();
  if (value === '') return null;
  switch (op) {
    case 'WITHIN_DAYS':
    case 'BEFORE_DAYS': {
      const days = Number(value);
      if (!Number.isInteger(days) || days < 0) return null;
      return `${field} ${op === 'WITHIN_DAYS' ? '>' : '<'} -${days}d`;
    }
    case 'IN': {
      const items = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      return items.length > 0 ? `${field} IN (${items.map(literal).join(', ')})` : null;
    }
    default:
      return `${field} ${op} ${literal(value)}`;
  }
}

/** The conditions joined into a query; those not filled in left out. */
export function buildQuery(conditions: readonly Condition[], join: Join): string {
  return conditions
    .map(conditionText)
    .filter((text): text is string => text !== null)
    .join(` ${join} `);
}

/** Text in a query, its quotes taken off and doubled quotes made single. */
function unquote(text: string): string {
  const quote = text.charAt(0);
  return (quote === "'" || quote === '"') && text.endsWith(quote)
    ? text.slice(1, -1).replaceAll(quote + quote, quote)
    : text;
}

const VALUE = String.raw`'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s()',"]+`;
const CONDITION = new RegExp(
  String.raw`^([a-z0-9_]+) (?:(>|<) -(\d+)d|(NOT CONTAINS|CONTAINS|>=|<=|!=|=|>|<) (${VALUE})|IN \(((?:${VALUE})(?:, ?(?:${VALUE}))*)\))$`,
  'i',
);

/** One condition read back, or null where it is not one the builder writes. */
function parseCondition(text: string): Condition | null {
  const match = CONDITION.exec(text.trim());
  if (!match) return null;
  const [, field, dateOp, days, op, value, list] = match;
  if (dateOp)
    return { field: field!, op: dateOp === '>' ? 'WITHIN_DAYS' : 'BEFORE_DAYS', value: days! };
  if (list !== undefined) {
    const items = [...list.matchAll(new RegExp(VALUE, 'g'))].map((item) => unquote(item[0]));
    return { field: field!, op: 'IN', value: items.join(', ') };
  }
  return { field: field!, op: op!.toUpperCase() as ConditionOp, value: unquote(value!) };
}

/**
 * A saved query as conditions joined one way, or null where the builder cannot show it: AND and
 * OR mixed, NOT, parentheses beyond a list's, or a condition it does not write.
 */
export function parseQuery(query: string): { join: Join; conditions: Condition[] } | null {
  const text = query.trim();
  if (text === '') return { join: 'AND', conditions: [] };
  // Split on AND or OR outside quotes and a list's parentheses.
  const parts: string[] = [];
  const joins = new Set<Join>();
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote) {
      if (char === quote) {
        if (text.charAt(index + 1) === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0) {
      const rest = text.slice(index);
      const join = /^\s+(AND|OR)\s+/i.exec(rest);
      if (join) {
        parts.push(text.slice(start, index));
        joins.add(join[1]!.toUpperCase() as Join);
        index += join[0].length - 1;
        start = index + 1;
      }
    }
  }
  parts.push(text.slice(start));
  if (joins.size > 1) return null;
  const conditions = parts.map(parseCondition);
  if (conditions.some((condition) => condition === null)) return null;
  return { join: [...joins][0] ?? 'AND', conditions: conditions as Condition[] };
}
