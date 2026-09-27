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

/** Maximum page size, as in Shopify's Admin API. */
export const MAX_PAGE_SIZE = 250;

export function pageSize(first: number | null | undefined, fallback = 50): number {
  const size = first ?? fallback;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw badUserInput(`first must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return size;
}
