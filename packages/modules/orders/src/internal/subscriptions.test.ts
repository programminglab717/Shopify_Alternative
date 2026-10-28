import { describe, expect, it } from 'vitest';
import { addDays, dayText, intervalText, nextOrderDay } from './subscriptions.js';

describe('Subscriptions (CAT-16, ADR-862)', () => {
  it('places the next order an interval later, a month from the 31st on its last day', () => {
    expect(nextOrderDay('2026-10-28', 'month', 1)).toBe('2026-11-28');
    expect(nextOrderDay('2026-01-31', 'month', 1)).toBe('2026-02-28');
    expect(nextOrderDay('2028-01-31', 'month', 1)).toBe('2028-02-29');
    expect(nextOrderDay('2026-11-30', 'month', 3)).toBe('2027-02-28');
    expect(nextOrderDay('2026-12-15', 'month', 1)).toBe('2027-01-15');
    expect(nextOrderDay('2026-12-28', 'week', 1)).toBe('2027-01-04');
    expect(nextOrderDay('2026-10-28', 'week', 2)).toBe('2026-11-11');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('says its interval and days as its pages do', () => {
    expect(intervalText('month', 1)).toBe('Every month');
    expect(intervalText('week', 2)).toBe('Every 2 weeks');
    expect(dayText('2026-11-28')).toBe('28 November 2026');
  });
});
