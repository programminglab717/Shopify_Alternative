import { badUserInput } from '../errors.js';

/** Opaque pagination cursors. Clients must not parse them. */
export function encodeCursor(position: Record<string, string>): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

export function decodeCursor<K extends string>(
  cursor: string,
  keys: readonly K[],
): Record<K, string> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (keys.every((key) => typeof record[key] === 'string')) {
        return record as Record<K, string>;
      }
    }
  } catch {
    // Fall through to the error below.
  }
  throw badUserInput('Invalid cursor');
}

/** A time to the microsecond, as `exactTime` writes it and cursors of lists in time order keep it. */
const EXACT_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

/**
 * Where the previous page of a list in time order ended: the ID of the row it ended with, which
 * is the caller's to check, and that row's time to the microsecond. A time on no real day, or not
 * to the microsecond, is refused, as Postgres would refuse it.
 */
export function decodeTimeCursor(cursor: string): { id: string; at: string } {
  const { id, at } = decodeCursor(cursor, ['id', 'at']);
  // A time the database reads as it is written: no 31st of February.
  const time = EXACT_TIME.exec(at);
  const real =
    time !== null && Date.parse(at) > 0 && new Date(at).toISOString().startsWith(time[1]!);
  if (!real) throw badUserInput('Invalid cursor');
  return { id, at };
}

/** Maximum page size, as in Shopify's Admin API. */
export const MAX_PAGE_SIZE = 250;

export function pageSize(first: number | null | undefined, fallback = 50): number {
  const size = first ?? fallback;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw badUserInput(`first must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return size;
}
