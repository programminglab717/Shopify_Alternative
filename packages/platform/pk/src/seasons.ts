import { addDays, islamicDaysIn } from './holidays.js';

// Pakistan's shopping seasons that follow the moon (INV-08, ADR-863): Ramadan, when shoppers buy
// for Eid ul Fitr, from its first day through Eid's third; and the days before Eid ul Adha, from
// Dhu al-Qadah's 25th through Eid's third. Each comes about eleven days earlier each year, so
// what sold last year in the same season is read from last year's dates, not this year's. Days
// are as Pakistan sights the moon, as its holidays are (ADR-594).

export type PkSeasonKey = 'ramadan' | 'eid_ul_adha';

export interface PkSeason {
  key: PkSeasonKey;
  /** Its first and last days, YYYY-MM-DD. */
  start: string;
  end: string;
}

/** How each season runs: from an Islamic month's day, to a day of Eid, and two days more. */
const SEASONS: readonly {
  key: PkSeasonKey;
  from: [month: number, day: number];
  eid: [month: number, day: number];
}[] = [
  { key: 'ramadan', from: [9, 1], eid: [10, 1] },
  { key: 'eid_ul_adha', from: [11, 25], eid: [12, 10] },
];

const byYear = new Map<number, PkSeason[]>();

/** The seasons that begin in the Gregorian `year`, in order. */
export function pkSeasonsOf(year: number): PkSeason[] {
  let seasons = byYear.get(year);
  if (seasons) return seasons;
  seasons = [];
  for (const { key, from, eid } of SEASONS) {
    for (const start of islamicDaysIn(year, ...from)) {
      // Its Eid is the first after it begins, which may fall in the next year.
      const eidDay = [...islamicDaysIn(year, ...eid), ...islamicDaysIn(year + 1, ...eid)].find(
        (day) => day > start,
      );
      if (eidDay) seasons.push({ key, start, end: addDays(eidDay, 2) });
    }
  }
  seasons.sort((a, b) => (a.start < b.start ? -1 : 1));
  byYear.set(year, seasons);
  return seasons;
}

/** The seasons any day of which falls from `from` to `to`, both YYYY-MM-DD, in order. */
export function pkSeasonsBetween(from: string, to: string): PkSeason[] {
  const first = Number(from.slice(0, 4));
  const last = Number(to.slice(0, 4));
  const found: PkSeason[] = [];
  for (let year = first - 1; year <= last; year++) {
    for (const season of pkSeasonsOf(year)) {
      if (season.start <= to && season.end >= from) found.push(season);
    }
  }
  return found;
}

/** The same season the Islamic year before `season`: some 354 days earlier. */
export function previousPkSeason(season: PkSeason): PkSeason | null {
  const year = Number(season.start.slice(0, 4));
  const earliest = addDays(season.start, -380);
  const latest = addDays(season.start, -330);
  return (
    [...pkSeasonsOf(year - 1), ...pkSeasonsOf(year)].find(
      (each) => each.key === season.key && each.start >= earliest && each.start <= latest,
    ) ?? null
  );
}

/** How many days of `from` to `to` (both inclusive, YYYY-MM-DD) fall in `season`. */
export function daysInSeason(season: PkSeason, from: string, to: string): number {
  const start = season.start > from ? season.start : from;
  const end = season.end < to ? season.end : to;
  if (start > end) return 0;
  return (
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  );
}
