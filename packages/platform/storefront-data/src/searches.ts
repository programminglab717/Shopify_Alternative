import type { Redis } from 'ioredis';
import { StorefrontKeys } from './keys.js';

// What a shop's shoppers search its storefront for (SRC-06, ADR-683): each search a shopper's
// page reports, by its words folded as the search reads them, counted in a hash of its day in
// the shop's time zone, and those that found nothing apart. The words are all that is kept, never
// who searched; a day keeps its first few thousand different searches, and counts the rest only
// in its totals.

export const SEARCHES = {
  /** How long a day's searches stay in Valkey: the longest a report looks back. */
  keepDays: 90,
  /** The longest a search's words are kept, folded. */
  termsMax: 100,
  /** The different searches a day keeps; more are counted in its totals alone. */
  termsPerDay: 2000,
} as const;

/** A search's words as they are counted: lower case, in one form, spaces made one. */
export function searchTermsOf(terms: string): string {
  return terms
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, SEARCHES.termsMax)
    .trim();
}

/** A search a page reported: its words, and whether it found anything. */
export interface SearchReport {
  terms: string;
  found: boolean;
}

/** A page's report, `{ q, n }`: its words and how much it found; null for anything else. */
export function searchReportOf(body: unknown): SearchReport | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { q, n } = body as Record<string, unknown>;
  if (typeof q !== 'string' || !(typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
    return null;
  }
  const terms = searchTermsOf(q);
  return terms === '' ? null : { terms, found: n > 0 };
}

/** A search's count over the days asked for. */
export interface SearchCount {
  terms: string;
  searches: number;
  /** Those of them that found nothing. */
  foundNothing: number;
}

/** Searches over the days asked for: all of them, and each of those kept. */
export interface SearchCounts {
  searches: number;
  foundNothing: number;
  terms: SearchCount[];
}

/**
 * Counts a day's search, kept among its different searches while there is room for it: a
 * search's fields are `s:` and `z:` before its words, the day's totals `searches` and `nothing`.
 */
const RECORD = `
local field = 's:' .. ARGV[1]
if redis.call('HEXISTS', KEYS[1], field) == 1 or redis.call('HLEN', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('HINCRBY', KEYS[1], field, 1)
  if ARGV[2] == '0' then redis.call('HINCRBY', KEYS[1], 'z:' .. ARGV[1], 1) end
end
redis.call('HINCRBY', KEYS[1], 'searches', 1)
if ARGV[2] == '0' then redis.call('HINCRBY', KEYS[1], 'nothing', 1) end
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1`;

/** Counts shoppers' searches for the storefront, and reads them for the core (ADR-683). */
export class StorefrontSearches {
  constructor(
    private readonly redis: Redis,
    private readonly keys = new StorefrontKeys(),
  ) {}

  /** A search on `day`, "2026-10-21" in the shop's time zone. */
  async record(shopId: string, day: string, report: SearchReport): Promise<void> {
    await this.redis.eval(
      RECORD,
      1,
      this.keys.searches(shopId, day),
      report.terms,
      report.found ? '1' : '0',
      // A search takes two fields at most: its count, and its count of finding nothing.
      SEARCHES.termsPerDay * 2 + 2,
      SEARCHES.keepDays * 24 * 60 * 60,
    );
  }

  /** The searches of `days`, added up, each search's words once. */
  async counts(shopId: string, days: readonly string[]): Promise<SearchCounts> {
    const pipeline = this.redis.pipeline();
    for (const day of days) pipeline.hgetall(this.keys.searches(shopId, day));
    const results = (await pipeline.exec()) ?? [];
    const counts: SearchCounts = { searches: 0, foundNothing: 0, terms: [] };
    const byTerms = new Map<string, SearchCount>();
    for (const [error, fields] of results) {
      if (error) throw error;
      for (const [field, value] of Object.entries(fields as Record<string, string>)) {
        const count = Number(value) || 0;
        if (field === 'searches') counts.searches += count;
        else if (field === 'nothing') counts.foundNothing += count;
        else if (field.startsWith('s:') || field.startsWith('z:')) {
          const terms = field.slice(2);
          let each = byTerms.get(terms);
          if (!each) byTerms.set(terms, (each = { terms, searches: 0, foundNothing: 0 }));
          if (field.startsWith('s:')) each.searches += count;
          else each.foundNothing += count;
        }
      }
    }
    counts.terms = [...byTerms.values()];
    return counts;
  }
}
