import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Timestamps in raw query results (`tx.execute(sql…)`) arrive as Postgres text, such as
 * "2026-09-28 09:42:15.75563+00": Drizzle turns off the driver's date parsing, and converts only
 * the columns of typed selects. Convert raw ones with these, as Drizzle does for typed ones.
 */
export function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not a timestamp: ${String(value)}`);
  return date;
}

export function toDateOrNull(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

/**
 * The time `column` holds, to the microsecond, as ISO 8601 in UTC: where a row sorts in a list in
 * time order, for the page after it. A `Date` keeps milliseconds alone, so a page after one would
 * start before the row it ended with, and bring it back.
 */
export function exactTime(column: SQLWrapper): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
