import type { Db } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { AuthError } from './errors.js';

// The theme store (OS-20, ADR-853): Hatti's partners (ADR-504), Pakistan's designers among them,
// offer themes they built on a development store to every shop, free or for a price in rupees.
// A theme offered is copied as it is then, one of Hatti's themes with the designer's JSON files
// over it; it shows in the store once Hatti has looked at it, and waits again whenever it is
// offered anew.

export const THEME_STORE_LIMITS = {
  themes: 20,
  name: 60,
  description: 1000,
  /** Paisa: what a paid theme costs at least, and at most. */
  leastPrice: 100_000n,
  mostPrice: 10_000_000n,
  /** Characters across a theme's files. */
  files: 2_000_000,
} as const;

/** A theme of the store, as shops and its designer see it. */
export interface ThemeListingRecord {
  id: string;
  name: string;
  description: string;
  /** The designer's business, as they named it joining. */
  designer: string;
  base: string;
  /** Paisa; nothing for a free theme. */
  price: bigint;
  listed: boolean;
  /** The development store and theme it was offered from. */
  sourceShopId: string;
  sourceThemeId: string;
  updatedAt: Date;
}

export interface ThemeOffer {
  shopId: string;
  themeId: string;
  name: string;
  description: string;
  price: bigint;
  base: string;
  files: readonly { filename: string; body: string }[];
}

type ListingRow = {
  id: string;
  name: string;
  description: string;
  business_name: string;
  base: string;
  price: string;
  listed_at: Date | string | null;
  source_shop: string;
  source_theme: string;
  updated_at: Date | string;
};

const COLUMNS = sql`t.id, t.name, t.description, p.business_name, t.base, t.price::text,
                    t.listed_at, t.source_shop, t.source_theme, t.updated_at`;

const toRecord = (row: ListingRow): ThemeListingRecord => ({
  id: row.id,
  name: row.name,
  description: row.description,
  designer: row.business_name,
  base: row.base,
  price: BigInt(row.price),
  listed: row.listed_at !== null,
  sourceShopId: row.source_shop,
  sourceThemeId: row.source_theme,
  updatedAt: new Date(row.updated_at),
});

const invalid = (message: string) => new AuthError('INVALID_INPUT', 422, message);

export class PartnerThemesService {
  private readonly db: Db;

  constructor(options: { db: Db }) {
    this.db = options.db;
  }

  /**
   * Offers the theme `offer.themeId` of the partner's development store `offer.shopId` to the
   * store, copied as it is now, or offers it anew: waiting for Hatti to look at it, either way.
   */
  async offer(userId: string, offer: ThemeOffer): Promise<ThemeListingRecord> {
    const name = offer.name.trim();
    const description = offer.description.trim();
    if (!name || name.length > THEME_STORE_LIMITS.name) {
      throw invalid(`Name the theme in ${THEME_STORE_LIMITS.name} characters at most`);
    }
    if (description.length > THEME_STORE_LIMITS.description) {
      throw invalid(`Describe it in ${THEME_STORE_LIMITS.description} characters at most`);
    }
    if (
      offer.price !== 0n &&
      (offer.price % 100n !== 0n ||
        offer.price < THEME_STORE_LIMITS.leastPrice ||
        offer.price > THEME_STORE_LIMITS.mostPrice)
    ) {
      throw invalid('A theme is free, or Rs 1,000 to Rs 100,000 in whole rupees');
    }
    const size = offer.files.reduce(
      (sum, file) => sum + file.filename.length + file.body.length,
      0,
    );
    if (size > THEME_STORE_LIMITS.files) throw invalid('The theme is too big to offer');
    const { rows: own } = await this.db.execute<{ count: number }>(sql`
      SELECT (SELECT count(*)::int FROM identity.partner_themes
               WHERE partner_id = ${userId}
                 AND (source_shop, source_theme) <> (${offer.shopId}::uuid, ${offer.themeId}::uuid)) AS count
        FROM identity.partner_stores s
       WHERE s.shop_id = ${offer.shopId} AND s.partner_id = ${userId}
         AND s.kind = 'development' AND s.transferred_at IS NULL`);
    if (!own[0]) {
      throw new AuthError('FORBIDDEN', 403, 'Offer themes from your own development stores');
    }
    if (own[0].count >= THEME_STORE_LIMITS.themes) {
      throw new AuthError(
        'TOO_MANY_THEMES',
        422,
        `A partner offers ${THEME_STORE_LIMITS.themes} themes at most`,
      );
    }
    const files = Object.fromEntries(offer.files.map((file) => [file.filename, file.body]));
    const { rows } = await this.db.execute<{ id: string }>(sql`
      INSERT INTO identity.partner_themes
             (partner_id, source_shop, source_theme, name, description, base, files, price)
      VALUES (${userId}, ${offer.shopId}, ${offer.themeId}, ${name}, ${description}, ${offer.base},
              ${JSON.stringify(files)}::jsonb, ${offer.price})
      ON CONFLICT (source_shop, source_theme) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description, base = EXCLUDED.base,
             files = EXCLUDED.files, price = EXCLUDED.price, listed_at = NULL, updated_at = now()
      RETURNING id`);
    return (await this.#find(sql`t.id = ${rows[0]!.id}`))[0]!;
  }

  /** The partner's themes in the store, oldest first. */
  async themes(userId: string): Promise<ThemeListingRecord[]> {
    return this.#find(sql`t.partner_id = ${userId}`);
  }

  /** The store's themes listed for every shop, the latest first. */
  async listed(): Promise<ThemeListingRecord[]> {
    return (await this.#find(sql`t.listed_at IS NOT NULL`)).reverse();
  }

  /**
   * The theme `id` with its files, to install: while it is listed, or `evenUnlisted` for a shop
   * that bought it. Null for none.
   */
  async listing(
    id: string,
    options: { evenUnlisted?: boolean } = {},
  ): Promise<(ThemeListingRecord & { files: { filename: string; body: string }[] }) | null> {
    const { rows } = await this.db.execute<ListingRow & { files: Record<string, string> }>(sql`
      SELECT ${COLUMNS}, t.files FROM identity.partner_themes t
        JOIN identity.partners p ON p.user_id = t.partner_id
       WHERE t.id = ${id} ${options.evenUnlisted ? sql`` : sql`AND t.listed_at IS NOT NULL`}`);
    const row = rows[0];
    if (!row) return null;
    return {
      ...toRecord(row),
      files: Object.entries(row.files)
        .map(([filename, body]) => ({ filename, body }))
        .sort((a, b) => a.filename.localeCompare(b.filename)),
    };
  }

  /** For Hatti's review: every theme, those waiting first. */
  async all(): Promise<ThemeListingRecord[]> {
    const { rows } = await this.db.execute<ListingRow>(sql`
      SELECT ${COLUMNS} FROM identity.partner_themes t
        JOIN identity.partners p ON p.user_id = t.partner_id
       ORDER BY t.listed_at IS NOT NULL, t.updated_at, t.id`);
    return rows.map(toRecord);
  }

  /** Hatti's review (ADR-853): the theme `id` listed for every shop, or taken back. */
  async review(id: string, listed: boolean): Promise<ThemeListingRecord | null> {
    const { rows } = await this.db.execute<{ id: string }>(sql`
      UPDATE identity.partner_themes
         SET listed_at = ${listed ? sql`coalesce(listed_at, now())` : sql`NULL`}
       WHERE id = ${id}
      RETURNING id`);
    return rows[0] ? ((await this.#find(sql`t.id = ${id}`))[0] ?? null) : null;
  }

  async #find(where: ReturnType<typeof sql>): Promise<ThemeListingRecord[]> {
    const { rows } = await this.db.execute<ListingRow>(sql`
      SELECT ${COLUMNS} FROM identity.partner_themes t
        JOIN identity.partners p ON p.user_id = t.partner_id
       WHERE ${where}
       ORDER BY t.created_at, t.id`);
    return rows.map(toRecord);
  }
}
