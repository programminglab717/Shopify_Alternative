import { Database, type Tx } from '@hatti/db';
import { prefixKey, searchKey } from '@hatti/pk';
import {
  CONTENT_TYPES,
  SEARCH_RESULTS,
  SEARCH_TERMS_MAX,
  type ContentSearchResponse,
  type ContentType,
} from '@hatti/storefront-api';
import { Controller, Get, Header, NotFoundException, Param, Query } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

// A storefront's search of a shop's own content (ADR-212): its published articles and pages with
// every word of what the shopper typed, found as its products are (ADR-046), by the words each
// keeps folded, `search_text`, its title first, and those of what the shop wrote in Urdu for it,
// `translated_text` (ADR-240).

/** The most of a page's or an article's text its words hold: its opening, where its subject is. */
export const SEARCHED_TEXT = 10_000;

/** The most words of what was typed a search reads, as the products' does. */
const SEARCH_WORDS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A page's or an article's words a search reads: its own first, then its Urdu's (ADR-240). */
const SEARCHED = sql.raw(`(search_text || ' ' || translated_text)`);

/**
 * The words a storefront's search finds a page or an article by, folded as products' are: its
 * title, what else names it, as an article's tags and author, then its HTML's text, as far as
 * {@link SEARCHED_TEXT}.
 */
export function contentSearchText(
  title: string,
  names: readonly string[],
  ...html: string[]
): string {
  const text = html
    .map((each) => each.replace(/<[^>]*>/g, ' ').replace(/&[#\w]+;/g, ' '))
    .join(' ')
    .slice(0, SEARCHED_TEXT);
  return searchKey([title, ...names, text].join(' '));
}

/**
 * The shop's published articles and pages with every word of `terms`, best first, in the caller's
 * transaction: those whose words begin nearer the first word typed, as a title holding it, then
 * the latest published. With `prefix`, the last word may be cut short.
 */
export async function searchContentIn(
  tx: Tx,
  shopId: string,
  terms: string,
  options: { limit: number; prefix?: boolean; types?: ReadonlySet<ContentType> },
): Promise<ContentSearchResponse> {
  const tokens = searchKey(terms).split(' ').filter(Boolean).slice(0, SEARCH_WORDS);
  if (tokens.length === 0) return { articleIds: [], pageIds: [] };
  if (options.prefix) tokens.push(prefixKey(tokens.pop()!));
  const types = options.types ?? new Set(CONTENT_TYPES);
  // Tokens hold only letters and digits, so no LIKE escaping.
  const all = sql.join(
    tokens.map((token) => sql`${SEARCHED} LIKE ${`%${token}%`}`),
    sql` AND `,
  );
  const find = async (table: SQL) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM ${table}
       WHERE shop_id = ${shopId} AND published_at <= now() AND ${all}
       ORDER BY position(${tokens[0]!} IN ${SEARCHED}), published_at DESC, id DESC
       LIMIT ${options.limit}`);
    return rows.map((row) => row.id);
  };
  return {
    articleIds: types.has('article') ? await find(sql`online_store.articles`) : [],
    pageIds: types.has('page') ? await find(sql`online_store.pages`) : [],
  };
}

/**
 * The search, as storefronts reach it (ADR-212): `GET /storefront/shops/{shop}/search/content?q=`
 * finds the shop's published articles and pages with every word of `q`, each kind up to `limit`
 * or {@link SEARCH_RESULTS}, those `types` names, both without it; with `prefix=last`, the last
 * word may be cut short. The host application checks the storefront key before this runs.
 */
@Controller('storefront/shops/:shopId/search/content')
export class StorefrontContentSearchController {
  constructor(private readonly db: Database) {}

  @Get()
  @Header('cache-control', 'no-store')
  async search(
    @Param('shopId') shopId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ContentSearchResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const terms = typeof query.q === 'string' ? query.q.slice(0, SEARCH_TERMS_MAX) : '';
    const asked = typeof query.limit === 'string' && /^\d{1,4}$/.test(query.limit);
    const limit = asked
      ? Math.min(Math.max(Number(query.limit), 1), SEARCH_RESULTS)
      : SEARCH_RESULTS;
    const named = typeof query.types === 'string' ? query.types.split(',') : CONTENT_TYPES;
    const types = new Set(CONTENT_TYPES.filter((type) => named.includes(type)));
    return this.db.tenant(shopId, (tx) =>
      searchContentIn(tx, shopId, terms, { limit, prefix: query.prefix === 'last', types }),
    );
  }
}
