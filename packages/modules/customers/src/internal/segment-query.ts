/**
 * The segment query language: conditions on customer fields joined with AND, OR, NOT and
 * parentheses, modelled on Shopify's segment queries.
 *
 *   number_of_orders >= 2 AND city IN (Lahore, Islamabad) AND last_order_date < -60d
 *   customer_tags CONTAINS 'wholesale' OR amount_spent BETWEEN 5000 AND 20000
 *
 * Keywords ignore case. Text is quoted ('Rahim Yar Khan'), or a bare word when it is one word.
 * Dates are days, like 2026-09-01, or days, weeks, months or years ago: -30d, -2w, -3m, -1y,
 * today and yesterday. Parsing checks only the shape of a query; which fields exist and what
 * values they take is checked when it is compiled (segment-sql.ts).
 */

export const SEGMENT_QUERY_LIMITS = {
  /** Characters in a query. */
  length: 5_000,
  conditions: 50,
  /** Parentheses inside parentheses. */
  depth: 10,
  /** Values in one IN list. */
  values: 100,
} as const;

/** A query that does not parse or check. `position` counts characters from 1. */
export class SegmentQueryError extends Error {
  constructor(
    readonly reason: string,
    readonly position: number | null = null,
  ) {
    super(position === null ? reason : `${reason} (at character ${position})`);
    this.name = 'SegmentQueryError';
  }
}

export type ComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=';

export type DateUnit = 'd' | 'w' | 'm' | 'y';

export type SegmentValue =
  | { kind: 'number'; text: string; position: number }
  /** Quoted text, or a bare word. */
  | { kind: 'text'; text: string; quoted: boolean; position: number }
  /** A day: 2026-09-01. */
  | { kind: 'date'; text: string; position: number }
  /** A number of days, weeks, months or years before today; today is 0 days. */
  | { kind: 'relative_date'; amount: number; unit: DateUnit; position: number }
  | { kind: 'boolean'; value: boolean; position: number };

interface FieldReference {
  field: string;
  position: number;
}

export type SegmentCondition =
  | (FieldReference & { kind: 'compare'; operator: ComparisonOperator; value: SegmentValue })
  | (FieldReference & { kind: 'in'; negated: boolean; values: SegmentValue[] })
  | (FieldReference & { kind: 'contains'; negated: boolean; value: SegmentValue })
  | (FieldReference & { kind: 'between'; low: SegmentValue; high: SegmentValue });

export type SegmentExpression =
  | { kind: 'and' | 'or'; items: SegmentExpression[] }
  | { kind: 'not'; item: SegmentExpression }
  | SegmentCondition;

type Token =
  | { type: 'word'; text: string; position: number }
  | { type: 'number'; text: string; position: number }
  | { type: 'date'; text: string; position: number }
  | { type: 'relative_date'; amount: number; unit: DateUnit; position: number }
  | { type: 'string'; text: string; position: number }
  | { type: 'operator'; text: ComparisonOperator; position: number }
  | { type: '(' | ')' | ','; position: number }
  | { type: 'end'; position: number };

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'contains',
  'between',
  'true',
  'false',
  'today',
  'yesterday',
]);

// A token ends where a word would go on: "2026-09-01x" is not a date.
const END = '(?![\\p{L}\\p{N}_])';
const TOKEN = new RegExp(
  [
    '(?<space>\\s+)',
    `(?<relative>-\\d{1,5}[dwmy]${END})`,
    `(?<date>\\d{4}-\\d{1,2}-\\d{1,2}${END})`,
    `(?<number>-?\\d+(?:\\.\\d+)?${END})`,
    '(?<word>[\\p{L}_][\\p{L}\\p{N}_]*)',
    '(?<operator>>=|<=|!=|<>|=|>|<)',
    '(?<punctuation>[(),])',
    '(?<quote>[\'"])',
  ].join('|'),
  'uy',
);

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < query.length) {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(query);
    const position = index + 1;
    const groups = match?.groups;
    if (!match || !groups) {
      throw new SegmentQueryError(`Unexpected "${query.charAt(index)}"`, position);
    }
    if (groups.quote) {
      const [text, end] = readString(query, index);
      tokens.push({ type: 'string', text, position });
      index = end;
      continue;
    }
    index += match[0].length;
    if (groups.space) continue;
    if (groups.relative) {
      tokens.push({
        type: 'relative_date',
        amount: Number(groups.relative.slice(1, -1)),
        unit: groups.relative.slice(-1) as DateUnit,
        position,
      });
    } else if (groups.date) {
      const [year, month, day] = groups.date.split('-');
      const text = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
      tokens.push({ type: 'date', text, position });
    } else if (groups.number) {
      tokens.push({ type: 'number', text: groups.number, position });
    } else if (groups.word) {
      tokens.push({ type: 'word', text: groups.word, position });
    } else if (groups.operator) {
      const text = groups.operator === '<>' ? '!=' : groups.operator;
      tokens.push({ type: 'operator', text: text as ComparisonOperator, position });
    } else {
      tokens.push({ type: groups.punctuation as '(' | ')' | ',', position });
    }
  }
  tokens.push({ type: 'end', position: query.length + 1 });
  return tokens;
}

/** Text between quotes, from the opening quote at `start`; a quote is escaped by doubling it. */
function readString(query: string, start: number): [string, number] {
  const quote = query.charAt(start);
  let text = '';
  let index = start + 1;
  while (index < query.length) {
    const char = query.charAt(index);
    if (char === quote) {
      if (query.charAt(index + 1) !== quote) return [text, index + 1];
      index += 1;
    }
    text += char;
    index += 1;
  }
  throw new SegmentQueryError(`Text starting here has no closing ${quote}`, start + 1);
}

function describe(token: Token): string {
  switch (token.type) {
    case 'end':
      return 'the end of the query';
    case 'word':
    case 'number':
    case 'date':
      return `"${token.text}"`;
    case 'string':
      return `'${token.text}'`;
    case 'relative_date':
      return `"-${token.amount}${token.unit}"`;
    case 'operator':
      return `"${token.text}"`;
    default:
      return `"${token.type}"`;
  }
}

class Parser {
  #index = 0;
  #conditions = 0;
  #depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): SegmentExpression {
    const expression = this.#or();
    const next = this.#peek();
    if (next.type !== 'end') {
      throw new SegmentQueryError(`Expected AND or OR, found ${describe(next)}`, next.position);
    }
    return expression;
  }

  #peek(): Token {
    return this.tokens[this.#index]!;
  }

  #next(): Token {
    const token = this.tokens[this.#index]!;
    if (token.type !== 'end') this.#index += 1;
    return token;
  }

  #isKeyword(token: Token, keyword: string): boolean {
    return token.type === 'word' && token.text.toLowerCase() === keyword;
  }

  #acceptKeyword(keyword: string): boolean {
    if (!this.#isKeyword(this.#peek(), keyword)) return false;
    this.#next();
    return true;
  }

  #expect(type: '(' | ')', what: string): void {
    const token = this.#next();
    if (token.type !== type) {
      throw new SegmentQueryError(`Expected ${what}, found ${describe(token)}`, token.position);
    }
  }

  #or(): SegmentExpression {
    const items = [this.#and()];
    while (this.#acceptKeyword('or')) items.push(this.#and());
    return items.length === 1 ? items[0]! : { kind: 'or', items };
  }

  #and(): SegmentExpression {
    const items = [this.#not()];
    while (this.#acceptKeyword('and')) items.push(this.#not());
    return items.length === 1 ? items[0]! : { kind: 'and', items };
  }

  #not(): SegmentExpression {
    if (this.#acceptKeyword('not')) return { kind: 'not', item: this.#not() };
    return this.#primary();
  }

  #primary(): SegmentExpression {
    const token = this.#peek();
    if (token.type === '(') {
      this.#next();
      this.#depth += 1;
      if (this.#depth > SEGMENT_QUERY_LIMITS.depth) {
        throw new SegmentQueryError(
          `Parentheses can go at most ${SEGMENT_QUERY_LIMITS.depth} deep`,
          token.position,
        );
      }
      const expression = this.#or();
      this.#expect(')', 'a closing ")"');
      this.#depth -= 1;
      return expression;
    }
    return this.#condition();
  }

  #condition(): SegmentCondition {
    const fieldToken = this.#next();
    if (fieldToken.type !== 'word' || KEYWORDS.has(fieldToken.text.toLowerCase())) {
      throw new SegmentQueryError(
        `Expected a field, like number_of_orders, found ${describe(fieldToken)}`,
        fieldToken.position,
      );
    }
    this.#conditions += 1;
    if (this.#conditions > SEGMENT_QUERY_LIMITS.conditions) {
      throw new SegmentQueryError(
        `A query can have at most ${SEGMENT_QUERY_LIMITS.conditions} conditions`,
        fieldToken.position,
      );
    }
    const reference = { field: fieldToken.text.toLowerCase(), position: fieldToken.position };

    const negated = this.#acceptKeyword('not');
    if (this.#acceptKeyword('in'))
      return { ...reference, kind: 'in', negated, values: this.#list() };
    if (this.#acceptKeyword('contains')) {
      return { ...reference, kind: 'contains', negated, value: this.#value() };
    }
    if (negated) {
      const token = this.#peek();
      throw new SegmentQueryError(
        `Expected IN or CONTAINS after NOT, found ${describe(token)}`,
        token.position,
      );
    }
    if (this.#acceptKeyword('between')) {
      const low = this.#value();
      if (!this.#acceptKeyword('and')) {
        const token = this.#peek();
        throw new SegmentQueryError(
          `Expected AND between the two values, found ${describe(token)}`,
          token.position,
        );
      }
      return { ...reference, kind: 'between', low, high: this.#value() };
    }
    const operator = this.#next();
    if (operator.type !== 'operator') {
      throw new SegmentQueryError(
        `Expected =, !=, >, >=, <, <=, IN, CONTAINS or BETWEEN after ${fieldToken.text}, found ` +
          describe(operator),
        operator.position,
      );
    }
    return { ...reference, kind: 'compare', operator: operator.text, value: this.#value() };
  }

  #list(): SegmentValue[] {
    this.#expect('(', 'a list in parentheses, like (Lahore, Islamabad)');
    const values = [this.#value()];
    while (this.#peek().type === ',') {
      this.#next();
      values.push(this.#value());
    }
    const close = this.#peek();
    if (values.length > SEGMENT_QUERY_LIMITS.values) {
      throw new SegmentQueryError(
        `A list can have at most ${SEGMENT_QUERY_LIMITS.values} values`,
        close.position,
      );
    }
    this.#expect(')', 'a comma or a closing ")"');
    return values;
  }

  #value(): SegmentValue {
    const token = this.#next();
    const position = token.position;
    switch (token.type) {
      case 'number':
        return { kind: 'number', text: token.text, position };
      case 'string':
        return { kind: 'text', text: token.text, quoted: true, position };
      case 'date':
        return { kind: 'date', text: token.text, position };
      case 'relative_date':
        return { kind: 'relative_date', amount: token.amount, unit: token.unit, position };
      case 'word': {
        const word = token.text.toLowerCase();
        if (word === 'true' || word === 'false') {
          return { kind: 'boolean', value: word === 'true', position };
        }
        if (word === 'today' || word === 'yesterday') {
          return {
            kind: 'relative_date',
            amount: word === 'today' ? 0 : 1,
            unit: 'd',
            position,
          };
        }
        if (KEYWORDS.has(word)) break;
        return { kind: 'text', text: token.text, quoted: false, position };
      }
      default:
        break;
    }
    throw new SegmentQueryError(`Expected a value, found ${describe(token)}`, position);
  }
}

/** Parses a segment query, or throws a {@link SegmentQueryError} saying what is wrong and where. */
export function parseSegmentQuery(query: string): SegmentExpression {
  if (query.trim() === '') throw new SegmentQueryError('The query is empty');
  if (query.length > SEGMENT_QUERY_LIMITS.length) {
    throw new SegmentQueryError(
      `A query can be at most ${SEGMENT_QUERY_LIMITS.length} characters long`,
    );
  }
  return new Parser(tokenize(query)).parse();
}
