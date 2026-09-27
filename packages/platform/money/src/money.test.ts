import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  add,
  allocate,
  compare,
  divideRounded,
  formatMoney,
  fromMajor,
  money,
  percentageOf,
  subtract,
  sum,
  times,
  toMajorString,
} from './index.js';

const pkr = (minor: number) => money(minor, 'PKR');

describe('arithmetic', () => {
  it('adds, subtracts and multiplies exactly', () => {
    expect(add(pkr(1050), pkr(50)).amount).toBe(1100n);
    expect(subtract(pkr(1050), pkr(2000)).amount).toBe(-950n);
    expect(times(pkr(125_000), 3).amount).toBe(375_000n);
    expect(sum([pkr(1), pkr(2), pkr(3)], 'PKR').amount).toBe(6n);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(pkr(1), money(1, 'USD'))).toThrow(MoneyError);
    expect(() => compare(pkr(1), money(1, 'AED'))).toThrow(MoneyError);
  });

  it('rejects unsafe number inputs', () => {
    expect(() => money(0.5, 'PKR')).toThrow(MoneyError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, 'PKR')).toThrow(MoneyError);
  });

  it('computes percentages in basis points', () => {
    // 15% of Rs 4,550.00
    expect(percentageOf(pkr(455_000), 1500).amount).toBe(68_250n);
    // 12.5% of Rs 0.99 = 12.375 paisa → half-even → 12
    expect(percentageOf(pkr(99), 1250).amount).toBe(12n);
  });
});

describe('divideRounded', () => {
  it.each([
    [5n, 2n, 'half-even', 2n],
    [7n, 2n, 'half-even', 4n],
    [-5n, 2n, 'half-even', -2n],
    [5n, 2n, 'half-up', 3n],
    [-5n, 2n, 'half-up', -3n],
    [-7n, 2n, 'floor', -4n],
    [-7n, 2n, 'ceil', -3n],
    [7n, 2n, 'truncate', 3n],
    [7n, -2n, 'floor', -4n],
  ] as const)('%s / %s with %s = %s', (n, d, mode, expected) => {
    expect(divideRounded(n, d, mode)).toBe(expected);
  });

  it('rejects division by zero', () => {
    expect(() => divideRounded(1n, 0n, 'half-even')).toThrow(RangeError);
  });
});

describe('allocate', () => {
  it('splits a discount so the parts add up exactly', () => {
    const parts = allocate(pkr(1000), [1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([334n, 333n, 333n]);
    expect(sum(parts, 'PKR').amount).toBe(1000n);
  });

  it('weights by line value and gives remainders to the largest fractions', () => {
    const parts = allocate(pkr(500), [4550_00, 1200_00, 250_00]);
    expect(sum(parts, 'PKR').amount).toBe(500n);
    expect(parts.map((p) => p.amount)).toEqual([379n, 100n, 21n]);
  });

  it('handles negative totals and zero weights', () => {
    const parts = allocate(pkr(-10), [1, 0, 1]);
    expect(parts.map((p) => p.amount)).toEqual([-5n, 0n, -5n]);
  });

  it('rejects invalid ratios', () => {
    expect(() => allocate(pkr(1), [])).toThrow(MoneyError);
    expect(() => allocate(pkr(1), [0, 0])).toThrow(MoneyError);
    expect(() => allocate(pkr(1), [-1, 2])).toThrow(MoneyError);
  });
});

describe('parsing and serialising', () => {
  it('parses major-unit strings', () => {
    expect(fromMajor('12,500.50', 'PKR').amount).toBe(1_250_050n);
    expect(fromMajor('4550', 'PKR').amount).toBe(455_000n);
    expect(fromMajor('-0.5', 'PKR').amount).toBe(-50n);
    expect(fromMajor(99.9, 'PKR').amount).toBe(9_990n);
  });

  it('rejects malformed or over-precise input', () => {
    expect(() => fromMajor('12.345', 'PKR')).toThrow(MoneyError);
    expect(() => fromMajor('Rs 100', 'PKR')).toThrow(MoneyError);
    expect(() => fromMajor('', 'PKR')).toThrow(MoneyError);
  });

  it('serialises to a decimal string', () => {
    expect(toMajorString(pkr(1_250_050))).toBe('12500.50');
    expect(toMajorString(pkr(5))).toBe('0.05');
    expect(toMajorString(pkr(-99))).toBe('-0.99');
  });
});

describe('formatMoney', () => {
  it('formats PKR the way Pakistani shoppers read it', () => {
    expect(formatMoney(pkr(1_250_000))).toBe('Rs 12,500');
    expect(formatMoney(pkr(1_250_050))).toBe('Rs 12,500.50');
    expect(formatMoney(pkr(99_900))).toBe('Rs 999');
  });

  it('supports lakh/crore grouping', () => {
    expect(formatMoney(pkr(12_500_000), { grouping: 'south-asian' })).toBe('Rs 1,25,000');
    expect(formatMoney(pkr(1_234_567_800), { grouping: 'south-asian' })).toBe('Rs 1,23,45,678');
  });

  it('supports display and decimal options', () => {
    expect(formatMoney(pkr(1_250_000), { display: 'code' })).toBe('PKR 12,500');
    expect(formatMoney(pkr(1_250_000), { display: 'none', decimals: 'always' })).toBe('12,500.00');
    expect(formatMoney(pkr(1_250_050), { decimals: 'never' })).toBe('Rs 12,501');
    expect(formatMoney(pkr(-9_950))).toBe('-Rs 99.50');
  });
});
