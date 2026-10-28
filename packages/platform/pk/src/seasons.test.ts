import { describe, expect, it } from 'vitest';
import { daysInSeason, pkSeasonsBetween, pkSeasonsOf, previousPkSeason } from './seasons.js';

describe("Pakistan's shopping seasons (INV-08, ADR-863)", () => {
  it('runs Ramadan through the third day of Eid ul Fitr, and the days before Eid ul Adha', () => {
    const seasons = pkSeasonsOf(2026);
    const ramadan = seasons.find((each) => each.key === 'ramadan')!;
    const adha = seasons.find((each) => each.key === 'eid_ul_adha')!;
    // Ramadan 1447 began on 18 February 2026 by Umm al-Qura, a day later as Pakistan sights it.
    expect(ramadan.start).toBe('2026-02-19');
    expect(ramadan.end > '2026-03-20' && ramadan.end < '2026-03-24').toBe(true);
    expect(adha.start < adha.end).toBe(true);
    expect(adha.start > ramadan.end).toBe(true);
  });

  it("finds a season's days in a span, and the same season a year before", () => {
    const [ramadan] = pkSeasonsBetween('2027-01-20', '2027-02-20');
    expect(ramadan!.key).toBe('ramadan');
    const before = previousPkSeason(ramadan!)!;
    expect(before.key).toBe('ramadan');
    expect(before.start).toBe(pkSeasonsOf(2026).find((each) => each.key === 'ramadan')!.start);
    expect(daysInSeason(ramadan!, ramadan!.start, ramadan!.start)).toBe(1);
    expect(daysInSeason(ramadan!, '2026-01-01', '2026-01-31')).toBe(0);
    const length = daysInSeason(ramadan!, '2027-01-01', '2027-12-31');
    expect(length >= 31 && length <= 33).toBe(true);
  });
});
