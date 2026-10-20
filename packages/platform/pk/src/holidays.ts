// Pakistan's public holidays, and the working days couriers deliver on (CHK-05, ADR-594): every
// day but Sunday and the holidays. Most fall on fixed days; the Islamic ones follow the moon, and
// their days come from the Umm al-Qura calendar (through Intl, whose ICU data has it) a day
// later, as Pakistan's sighting usually is, until the Ruet-e-Hilal committee sights the moon.
// Days are YYYY-MM-DD, in Pakistan's time.

/** The holidays a year has on fixed days: month and day. */
const FIXED: readonly (readonly [number, number])[] = [
  [2, 5], // Kashmir Solidarity Day
  [3, 23], // Pakistan Day
  [5, 1], // Labour Day
  [8, 14], // Independence Day
  [11, 9], // Iqbal Day
  [12, 25], // Quaid-e-Azam Day
];

/** The Islamic holidays: month, first day and how many days. */
const ISLAMIC: readonly (readonly [number, number, number])[] = [
  [10, 1, 3], // Eid ul Fitr
  [12, 10, 3], // Eid ul Adha
  [1, 9, 2], // Ashura
  [3, 12, 1], // Eid Milad un Nabi
];

const DAY_MS = 86_400_000;

/** The day `days` after `day` (before, if negative). */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function ymd(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

const HIJRI = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

const hijriByYear = new Map<number, Map<string, string>>();

/** Each day of a Gregorian year by its Umm al-Qura date, "year-month-day" (1-based months). */
function hijriDaysOf(year: number): Map<string, string> {
  let days = hijriByYear.get(year);
  if (days) return days;
  days = new Map();
  for (let day = ymd(year, 1, 1); day.startsWith(String(year)); day = addDays(day, 1)) {
    const parts = HIJRI.formatToParts(new Date(`${day}T12:00:00Z`));
    const part = (type: string) => parts.find((each) => each.type === type)?.value;
    days.set(`${Number.parseInt(part('year') ?? '', 10)}-${part('month')}-${part('day')}`, day);
  }
  hijriByYear.set(year, days);
  return days;
}

/** The Gregorian days of `year` that are the Islamic `month`'s `day`, as Pakistan sights it. */
export function islamicDaysIn(year: number, month: number, day: number): string[] {
  const found: string[] = [];
  for (const [hijri, gregorian] of hijriDaysOf(year)) {
    if (hijri.endsWith(`-${month}-${day}`)) found.push(addDays(gregorian, 1));
  }
  return found.sort();
}

const holidaysByYear = new Map<number, ReadonlySet<string>>();

/** Pakistan's public holidays in `year`, the Islamic ones as expected until sighted. */
export function pkHolidaysOf(year: number): ReadonlySet<string> {
  let days = holidaysByYear.get(year);
  if (days) return days;
  const found = new Set(FIXED.map(([month, day]) => ymd(year, month, day)));
  // An Islamic holiday beginning late in the year before may run into this one.
  for (const [month, first, length] of ISLAMIC) {
    for (const start of [
      ...islamicDaysIn(year - 1, month, first),
      ...islamicDaysIn(year, month, first),
    ]) {
      for (let each = 0; each < length; each++) {
        const day = addDays(start, each);
        if (day.startsWith(String(year))) found.add(day);
      }
    }
  }
  days = found;
  holidaysByYear.set(year, days);
  return days;
}

/** Whether couriers deliver on `day`: neither a Sunday nor a public holiday. */
export function isPkWorkingDay(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && !pkHolidaysOf(Number(day.slice(0, 4))).has(day);
}

/**
 * The working day `days` working days after `day`: the first after it for 1. For 0, `day`
 * itself where it is a working day, else the next.
 */
export function addPkWorkingDays(day: string, days: number): string {
  let at = day;
  if (days <= 0) {
    while (!isPkWorkingDay(at)) at = addDays(at, 1);
    return at;
  }
  for (let left = days; left > 0;) {
    at = addDays(at, 1);
    if (isPkWorkingDay(at)) left--;
  }
  return at;
}

/** The hour it is at `at` in Pakistan, 0 to 23. */
export function pkHourOf(at: Date): number {
  return new Date(at.getTime() + 5 * 3_600_000).getUTCHours();
}

/** The day it is at `at` in Pakistan, YYYY-MM-DD. */
export function pkDayOf(at: Date): string {
  // Pakistan keeps UTC+5 all year.
  return new Date(at.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);
}
