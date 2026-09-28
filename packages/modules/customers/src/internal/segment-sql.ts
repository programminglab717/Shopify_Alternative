import { fromMajor, type CurrencyCode } from '@hatti/money';
import { sql, type SQL } from 'drizzle-orm';
import {
  SEGMENT_OPERATORS,
  type RegisteredSegmentField,
  type SegmentFactSource,
  type SegmentField,
  type SegmentFieldRegistry,
} from './segment-fields.js';
import {
  SegmentQueryError,
  parseSegmentQuery,
  type ComparisonOperator,
  type SegmentCondition,
  type SegmentExpression,
  type SegmentValue,
} from './segment-query.js';

export interface SegmentContext {
  shopId: string;
  /** Amounts in queries are in the shop's currency. */
  currency: CurrencyCode;
  /** Days, and "30 days ago", are counted in this time zone. */
  timeZone: string;
}

/** A query as SQL over `customers.customers c`: joins for its fact sources, and a condition. */
export interface CompiledSegment {
  joins: SQL;
  where: SQL;
}

const SQL_OPERATORS: Record<ComparisonOperator, SQL> = {
  '=': sql.raw('='),
  '!=': sql.raw('<>'),
  '>': sql.raw('>'),
  '>=': sql.raw('>='),
  '<': sql.raw('<'),
  '<=': sql.raw('<='),
};

const INTERVALS = {
  d: (amount: number) => sql`make_interval(days => ${amount})`,
  w: (amount: number) => sql`make_interval(weeks => ${amount})`,
  m: (amount: number) => sql`make_interval(months => ${amount})`,
  y: (amount: number) => sql`make_interval(years => ${amount})`,
} as const;

/** Edit distance, to suggest the field someone meant. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

function unknownField(name: string, position: number, registry: SegmentFieldRegistry): never {
  const names = registry.fields().map((field) => field.name);
  const close = names
    .map((candidate) => ({
      candidate,
      score: candidate.includes(name) || name.includes(candidate) ? 0 : distance(name, candidate),
    }))
    .filter(({ score }) => score <= 3)
    .sort((a, b) => a.score - b.score)[0];
  throw new SegmentQueryError(
    `Unknown field "${name}". ` +
      (close ? `Did you mean ${close.candidate}?` : `Fields: ${names.join(', ')}`),
    position,
  );
}

class Compiler {
  readonly sources = new Map<string, SegmentFactSource>();

  constructor(
    private readonly registry: SegmentFieldRegistry,
    private readonly context: SegmentContext,
  ) {}

  expression(expression: SegmentExpression): SQL {
    switch (expression.kind) {
      case 'and':
      case 'or': {
        const joiner = expression.kind === 'and' ? sql` AND ` : sql` OR `;
        return sql`(${sql.join(
          expression.items.map((item) => this.expression(item)),
          joiner,
        )})`;
      }
      case 'not':
        return sql`(NOT ${this.expression(expression.item)})`;
      default: {
        // Two-valued: a customer without a value (no orders yet) fails the condition, so NOT
        // around it matches them.
        return sql`coalesce(${this.#condition(expression)}, false)`;
      }
    }
  }

  #condition(condition: SegmentCondition): SQL {
    const entry: RegisteredSegmentField =
      this.registry.get(condition.field) ??
      unknownField(condition.field, condition.position, this.registry);
    if (entry.source) this.sources.set(entry.source.key, entry.source);
    const { field } = entry;
    switch (field.type) {
      case 'number':
      case 'money':
      case 'date':
        return this.#ordered(field, condition);
      case 'text':
        return this.#text(field, condition);
      case 'text_list':
        return this.#list(field, condition);
      case 'boolean':
        return this.#boolean(field, condition);
    }
  }

  #wrongOperator(field: SegmentField, condition: SegmentCondition): never {
    const kinds: Record<string, string> = {
      number: 'is a number',
      money: 'is an amount',
      date: 'is a date',
      text: 'is text',
      text_list: 'is a list',
      boolean: 'is true or false',
    };
    throw new SegmentQueryError(
      `${field.name} ${kinds[field.type]}: use ${SEGMENT_OPERATORS[field.type].join(', ')}`,
      condition.position,
    );
  }

  /** Numbers, amounts and dates: compared, or between two values. */
  #ordered(field: SegmentField, condition: SegmentCondition): SQL {
    const left =
      field.type === 'date'
        ? sql`(${field.sql} AT TIME ZONE ${this.context.timeZone})::date`
        : field.sql;
    if (condition.kind === 'compare') {
      return sql`${left} ${SQL_OPERATORS[condition.operator]} ${this.#ordinal(field, condition.value)}`;
    }
    if (condition.kind === 'between') {
      return sql`${left} BETWEEN ${this.#ordinal(field, condition.low)} AND ${this.#ordinal(field, condition.high)}`;
    }
    return this.#wrongOperator(field, condition);
  }

  #ordinal(field: SegmentField, value: SegmentValue): SQL {
    if (field.type === 'number') {
      if (value.kind === 'number' && /^-?\d{1,12}$/.test(value.text)) {
        return sql`${Number(value.text)}::bigint`;
      }
      throw new SegmentQueryError(`${field.name} takes a whole number, like 2`, value.position);
    }
    if (field.type === 'money') {
      if (value.kind === 'number' || value.kind === 'text') {
        try {
          return sql`${fromMajor(value.text, this.context.currency).amount.toString()}::bigint`;
        } catch {
          // Reported below.
        }
      }
      throw new SegmentQueryError(
        `${field.name} takes an amount, like 2500 or '2,499.50'`,
        value.position,
      );
    }
    if (value.kind === 'date' && isDay(value.text)) return sql`${value.text}::date`;
    if (value.kind === 'relative_date') {
      const today = sql`(now() AT TIME ZONE ${this.context.timeZone})::date`;
      return sql`(${today} - ${INTERVALS[value.unit](value.amount)})::date`;
    }
    throw new SegmentQueryError(
      `${field.name} takes a date, like 2026-09-01, or -30d for 30 days ago`,
      value.position,
    );
  }

  #textValue(field: SegmentField, value: SegmentValue): string {
    if (value.kind !== 'text') {
      throw new SegmentQueryError(
        `${field.name} takes text; put it in quotes, like '${describeValue(value)}'`,
        value.position,
      );
    }
    if (!field.normalize) return value.text;
    const normalized = field.normalize(value.text);
    if (normalized === null) {
      throw new SegmentQueryError(
        `"${value.text}" ${field.invalidValue ?? 'is not a valid value'}`,
        value.position,
      );
    }
    return normalized;
  }

  #text(field: SegmentField, condition: SegmentCondition): SQL {
    if (condition.kind === 'compare' && condition.operator === '=') {
      return sql`lower(${field.sql}) = lower(${this.#textValue(field, condition.value)}::text)`;
    }
    if (condition.kind === 'compare' && condition.operator === '!=') {
      return sql`lower(${field.sql}) IS DISTINCT FROM lower(${this.#textValue(field, condition.value)}::text)`;
    }
    if (condition.kind === 'in') {
      const values = condition.values.map(
        (value) => sql`lower(${this.#textValue(field, value)}::text)`,
      );
      const inList = sql`coalesce(lower(${field.sql}) IN (${sql.join(values, sql`, `)}), false)`;
      return condition.negated ? sql`NOT ${inList}` : inList;
    }
    return this.#wrongOperator(field, condition);
  }

  #list(field: SegmentField, condition: SegmentCondition): SQL {
    if (condition.kind !== 'contains') return this.#wrongOperator(field, condition);
    const value = this.#textValue(field, condition.value);
    const contains = sql`EXISTS (SELECT 1 FROM unnest(${field.sql}) AS item(value)
                                  WHERE lower(item.value) = lower(${value}::text))`;
    return condition.negated ? sql`NOT ${contains}` : contains;
  }

  #boolean(field: SegmentField, condition: SegmentCondition): SQL {
    if (
      condition.kind !== 'compare' ||
      (condition.operator !== '=' && condition.operator !== '!=')
    ) {
      return this.#wrongOperator(field, condition);
    }
    if (condition.value.kind !== 'boolean') {
      throw new SegmentQueryError(`${field.name} takes true or false`, condition.value.position);
    }
    const value = condition.operator === '=' ? condition.value.value : !condition.value.value;
    return sql`(${field.sql}) = ${value}::boolean`;
  }
}

function isDay(text: string): boolean {
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

function describeValue(value: SegmentValue): string {
  switch (value.kind) {
    case 'number':
    case 'date':
      return value.text;
    case 'relative_date':
      return `-${value.amount}${value.unit}`;
    case 'boolean':
      return String(value.value);
    default:
      return value.text;
  }
}

/**
 * Compiles a segment query to SQL over `customers.customers c`, or throws a
 * {@link SegmentQueryError}. Values become parameters; field SQL comes from the registry.
 */
export function compileSegmentQuery(
  query: string,
  registry: SegmentFieldRegistry,
  context: SegmentContext,
): CompiledSegment {
  const compiler = new Compiler(registry, context);
  const where = compiler.expression(parseSegmentQuery(query));
  const joins = [...compiler.sources.values()].map((source) => {
    const alias = sql.raw(source.key);
    return sql`LEFT JOIN (${source.query(context.shopId)}) AS ${alias} ON ${alias}.customer_id = c.id`;
  });
  return { joins: sql.join(joins, sql` `), where };
}
