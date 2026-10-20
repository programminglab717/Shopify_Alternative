import { describe, expect, it } from 'vitest';
import { addPkWorkingDays, isPkWorkingDay, pkDayOf, pkHolidaysOf } from './index.js';

describe("Pakistan's holidays and working days (ADR-594)", () => {
  it("lists a year's public holidays, the Islamic ones as Pakistan usually sights them", () => {
    expect([...pkHolidaysOf(2026)].sort()).toEqual([
      '2026-02-05',
      '2026-03-21',
      '2026-03-22',
      '2026-03-23',
      '2026-05-01',
      '2026-05-28',
      '2026-05-29',
      '2026-05-30',
      '2026-06-25',
      '2026-06-26',
      '2026-08-14',
      '2026-08-26',
      '2026-11-09',
      '2026-12-25',
    ]);
  });

  it('counts working days past Sundays and holidays', () => {
    // Tuesday 20 October 2026: Wednesday, then Thursday.
    expect(addPkWorkingDays('2026-10-20', 1)).toBe('2026-10-21');
    expect(addPkWorkingDays('2026-10-20', 2)).toBe('2026-10-22');
    // From Friday, past Sunday.
    expect(addPkWorkingDays('2026-10-23', 2)).toBe('2026-10-26');
    // Past Iqbal Day, Monday 9 November, and the Sunday before it.
    expect(addPkWorkingDays('2026-11-07', 1)).toBe('2026-11-10');
    // Past Eid ul Adha's three days.
    expect(addPkWorkingDays('2026-05-27', 1)).toBe('2026-06-01');
    // None: the day itself where it is a working day, else the next.
    expect(addPkWorkingDays('2026-10-20', 0)).toBe('2026-10-20');
    expect(addPkWorkingDays('2026-10-25', 0)).toBe('2026-10-26');
    expect(isPkWorkingDay('2026-08-14')).toBe(false);
    expect(isPkWorkingDay('2026-10-24')).toBe(true);
  });

  it("says what day it is in Pakistan's time", () => {
    expect(pkDayOf(new Date('2026-10-20T18:59:59Z'))).toBe('2026-10-20');
    expect(pkDayOf(new Date('2026-10-20T19:00:00Z'))).toBe('2026-10-21');
  });
});
