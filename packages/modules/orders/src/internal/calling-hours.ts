import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';

// The Confirmation Desk's calling hours (COD-05, ADR-091): the time of day in which a shop calls
// its customers, in its time zone, as the instants of each day's window around a moment.

/** A shop's calling hours: minutes after midnight in its time zone, `opens` before `closes`. */
export interface CallingHoursValue {
  opens: number;
  closes: number;
}

/** One day's calling hours, as instants. */
export interface CallingWindow {
  opens: Date;
  closes: Date;
}

export const CALLING_HOURS_LIMITS = {
  /** The shortest calling day, in minutes. */
  minimumMinutes: 60,
  firstCallMinutes: { min: 5, max: 1440 },
} as const;

/** "10:00" as minutes after midnight, "24:00" the end of the day; null for anything else. */
export function minutesOfClock(text: string): number | null {
  const match = /^([01]?\d|2[0-4]):([0-5]\d)$/.exec(text.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= 1440 ? minutes : null;
}

/** Minutes after midnight as a clock: 600 is "10:00". */
export function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The windows of `hours` in time zone `timezone`, by the shop's own days: from `back` days
 * before the day of `at` to `ahead` days after it, earliest first.
 */
export async function callingWindowsIn(
  tx: Tx,
  hours: CallingHoursValue,
  timezone: string,
  at: Date,
  days: { back: number; ahead: number },
): Promise<CallingWindow[]> {
  const today = sql`(${at.toISOString()}::timestamptz AT TIME ZONE ${timezone})::date`;
  // Local midnights, without a time zone, so that AT TIME ZONE reads them as the shop's.
  const { rows } = await tx.execute<{ opens_at: string | Date; closes_at: string | Date }>(sql`
    SELECT (d + make_interval(mins => ${hours.opens})) AT TIME ZONE ${timezone} AS opens_at,
           (d + make_interval(mins => ${hours.closes})) AT TIME ZONE ${timezone} AS closes_at
      FROM generate_series((${today} - ${days.back}::int)::timestamp,
                           (${today} + ${days.ahead}::int)::timestamp, interval '1 day') AS d
     ORDER BY 1`);
  return rows.map((row) => ({ opens: new Date(row.opens_at), closes: new Date(row.closes_at) }));
}

/** Whether `at` is in calling hours. */
export function isCallingTime(windows: readonly CallingWindow[], at: Date): boolean {
  return windows.some((window) => window.opens <= at && at < window.closes);
}

/** `at`, if it is in calling hours, else when they next open; null past the windows. */
export function callingTimeFrom(windows: readonly CallingWindow[], at: Date): Date | null {
  for (const window of windows) {
    if (at < window.opens) return window.opens;
    if (at < window.closes) return at;
  }
  return null;
}

/**
 * The moment `minutes` of calling hours before `at`, counting back through the windows: an order
 * placed before it has waited longer than that. Before the earliest window, if they run out.
 */
export function callingMinutesBefore(
  windows: readonly CallingWindow[],
  at: Date,
  minutes: number,
): Date {
  let remaining = minutes * 60_000;
  for (let index = windows.length - 1; index >= 0; index--) {
    const window = windows[index]!;
    if (window.opens >= at) continue;
    const end = window.closes < at ? window.closes : at;
    const length = end.getTime() - window.opens.getTime();
    if (remaining <= length) return new Date(end.getTime() - remaining);
    remaining -= length;
  }
  return new Date((windows[0]?.opens ?? at).getTime() - 1);
}
