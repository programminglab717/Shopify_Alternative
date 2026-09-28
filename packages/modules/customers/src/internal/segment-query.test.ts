import { describe, expect, it } from 'vitest';
import { SEGMENT_QUERY_LIMITS, SegmentQueryError, parseSegmentQuery } from './segment-query.js';

/** The error a query fails with. */
function failure(query: string): SegmentQueryError {
  try {
    parseSegmentQuery(query);
  } catch (error) {
    if (error instanceof SegmentQueryError) return error;
    throw error;
  }
  throw new Error(`Expected "${query}" to fail`);
}

describe('segment query language', () => {
  it('parses comparisons of numbers, text, dates and booleans', () => {
    expect(parseSegmentQuery('number_of_orders >= 2')).toEqual({
      kind: 'compare',
      field: 'number_of_orders',
      position: 1,
      operator: '>=',
      value: { kind: 'number', text: '2', position: 21 },
    });
    expect(parseSegmentQuery("City = 'Rahim Yar Khan'")).toMatchObject({
      field: 'city',
      value: { kind: 'text', text: 'Rahim Yar Khan', quoted: true },
    });
    expect(parseSegmentQuery('city <> Lahore')).toMatchObject({
      operator: '!=',
      value: { kind: 'text', text: 'Lahore', quoted: false },
    });
    expect(parseSegmentQuery('last_order_date > 2026-09-01')).toMatchObject({
      value: { kind: 'date', text: '2026-09-01' },
    });
    expect(parseSegmentQuery('last_order_date > 2026-9-1')).toMatchObject({
      value: { kind: 'date', text: '2026-09-01' },
    });
    expect(parseSegmentQuery('last_order_date < -60d')).toMatchObject({
      value: { kind: 'relative_date', amount: 60, unit: 'd' },
    });
    expect(parseSegmentQuery('customer_added_date >= yesterday')).toMatchObject({
      value: { kind: 'relative_date', amount: 1, unit: 'd' },
    });
    expect(parseSegmentQuery('blocked = FALSE')).toMatchObject({
      value: { kind: 'boolean', value: false },
    });
    expect(parseSegmentQuery("customer_tags contains 'قیمتی گاہک'")).toMatchObject({
      kind: 'contains',
      negated: false,
      value: { text: 'قیمتی گاہک' },
    });
    expect(parseSegmentQuery("note = 'Ali''s shop'")).toMatchObject({
      value: { text: "Ali's shop" },
    });
  });

  it('parses lists, NOT IN, NOT CONTAINS and BETWEEN', () => {
    expect(parseSegmentQuery("city IN (Lahore, 'Islamabad', karachi)")).toMatchObject({
      kind: 'in',
      negated: false,
      values: [{ text: 'Lahore' }, { text: 'Islamabad' }, { text: 'karachi' }],
    });
    expect(parseSegmentQuery('province NOT IN (PB)')).toMatchObject({ kind: 'in', negated: true });
    expect(parseSegmentQuery("customer_tags NOT CONTAINS 'vip'")).toMatchObject({
      kind: 'contains',
      negated: true,
    });
    expect(parseSegmentQuery('amount_spent BETWEEN 5000 AND 20000.50')).toMatchObject({
      kind: 'between',
      low: { text: '5000' },
      high: { text: '20000.50' },
    });
  });

  it('binds AND tighter than OR, and honours NOT and parentheses', () => {
    expect(parseSegmentQuery('a = 1 OR b = 2 AND c = 3')).toMatchObject({
      kind: 'or',
      items: [{ field: 'a' }, { kind: 'and', items: [{ field: 'b' }, { field: 'c' }] }],
    });
    expect(parseSegmentQuery('(a = 1 OR b = 2) and not c = 3')).toMatchObject({
      kind: 'and',
      items: [
        { kind: 'or', items: [{ field: 'a' }, { field: 'b' }] },
        { kind: 'not', item: { field: 'c' } },
      ],
    });
    expect(parseSegmentQuery('NOT NOT a = 1')).toMatchObject({
      kind: 'not',
      item: { kind: 'not', item: { field: 'a' } },
    });
  });

  it('says what is wrong, and where', () => {
    expect(failure('').message).toBe('The query is empty');
    expect(failure('number_of_orders >=').message).toBe(
      'Expected a value, found the end of the query (at character 20)',
    );
    expect(failure('number_of_orders 2').message).toBe(
      'Expected =, !=, >, >=, <, <=, IN, CONTAINS or BETWEEN after number_of_orders, found "2" ' +
        '(at character 18)',
    );
    expect(failure('a = 1 b = 2')).toMatchObject({
      reason: 'Expected AND or OR, found "b"',
      position: 7,
    });
    expect(failure('(a = 1').reason).toBe('Expected a closing ")", found the end of the query');
    expect(failure("city = 'Lahore").position).toBe(8);
    expect(failure('city = Lahore;').reason).toBe('Unexpected ";"');
    expect(failure('AND a = 1').reason).toBe(
      'Expected a field, like number_of_orders, found "AND"',
    );
    expect(failure('city NOT = Lahore').reason).toBe(
      'Expected IN or CONTAINS after NOT, found "="',
    );
    expect(failure('city IN Lahore').reason).toBe(
      'Expected a list in parentheses, like (Lahore, Islamabad), found "Lahore"',
    );
    expect(failure('amount_spent BETWEEN 1 OR 2').reason).toBe(
      'Expected AND between the two values, found "OR"',
    );
    expect(failure('city = AND').reason).toBe('Expected a value, found "AND"');
  });

  it('keeps queries to a reasonable size', () => {
    expect(failure('a = 1 AND '.repeat(600) + 'a = 1').reason).toBe(
      `A query can be at most ${SEGMENT_QUERY_LIMITS.length} characters long`,
    );
    expect(failure(Array.from({ length: 51 }, () => 'a = 1').join(' OR ')).reason).toBe(
      'A query can have at most 50 conditions',
    );
    expect(failure('('.repeat(11) + 'a = 1' + ')'.repeat(11)).reason).toBe(
      'Parentheses can go at most 10 deep',
    );
    const values = Array.from({ length: 101 }, (_, index) => `c${index}`).join(', ');
    expect(failure(`city IN (${values})`).reason).toBe('A list can have at most 100 values');
  });
});
