import { Database } from '@hatti/db';
import { sql, type SQL } from 'drizzle-orm';
import { StockHolds } from './stock-holds.js';

/** What expires, each in its table: checkouts first, so carts going after them update none. */
const EXPIRING = {
  checkouts: sql`checkout.checkouts`,
  carts: sql`checkout.carts`,
  proofs: sql`checkout.number_proofs`,
  // Codes to sign in with, which no checkout takes with it, and sessions signed in (ADR-570).
  codes: sql`checkout.number_codes`,
  sessions: sql`checkout.account_sessions`,
} as const satisfies Record<string, SQL>;

/**
 * What else must have passed: a checkout with a number is kept for its shop past its page's day,
 * as an abandoned checkout (ADR-393); a code is the sweep's only to sign in with, a checkout's
 * going with it, and only once its day is up, as until then it counts towards the codes its number
 * is sent in a day.
 */
const KEPT: Partial<Record<keyof typeof EXPIRING, (at: string) => SQL>> = {
  // And holds none (ADR-715): its hold is given back first, for its stock to sell again.
  checkouts: (at) => sql`AND (kept_until IS NULL OR kept_until <= ${at}) AND held IS NULL`,
  codes: (at) =>
    sql`AND purpose = 'sign_in' AND created_at <= ${at}::timestamptz - interval '1 day'`,
};

/**
 * How many of each kind a sweep deleted; of `wishlists`, the items of numbers' own wishlists
 * (ADR-575) left with no session; and of `holds`, the checkouts whose stock it gave back as their
 * minutes ran out (ADR-715).
 */
export type ExpiredCounts = Record<keyof typeof EXPIRING | 'wishlists' | 'holds', number>;

/** Rows of each kind found past their time at a time, across shops. */
export const EXPIRY_BATCH = 1_000;

/**
 * The checkout module's rows past their time (ADR-042, ADR-230): checkouts, their codes with
 * them; carts; browsers' proofs of a number (ADR-199); and codes to sign in to shoppers' accounts
 * and the sessions signed in, lapsed or signed out (ADR-570). Nothing reads one once it has
 * expired: a secret naming a cart that is gone is never taken up, a checkout's page says it
 * expired, a proof spares no code and a session reads no account. The worker's sweep deletes them, so that shoppers' requests delete none,
 * and a shop that gets no new carts keeps no old ones. So too the wishlists kept by a number no
 * customer has (ADR-575), once the number is signed in nowhere: they go with its last session.
 */
export class CheckoutExpiry {
  readonly #holds: StockHolds;

  constructor(private readonly db: Database) {
    this.#holds = new StockHolds(db);
  }

  /**
   * Deletes up to `limit` of each kind past their time at `at`, the longest expired first, across
   * shops: found with the system role, and each shop's deleted in its own transaction unless it
   * changed since, as a cart does when its shopper comes back in time. How many of each it
   * deleted. A shop whose transaction fails is told to `failed`, and the rest go on; without
   * `failed`, its error is thrown.
   */
  async deleteExpired(
    at: Date = new Date(),
    limit = EXPIRY_BATCH,
    failed?: (shopId: string, error: unknown) => void,
  ): Promise<ExpiredCounts> {
    const deleted: ExpiredCounts = {
      checkouts: 0,
      carts: 0,
      proofs: 0,
      codes: 0,
      sessions: 0,
      wishlists: 0,
      holds: 0,
    };
    // Holds whose minutes ran out first: a checkout past its day is deleted once it holds none.
    deleted.holds = await this.#holds.releaseLapsed(at, limit, failed);
    for (const kind of Object.keys(EXPIRING) as (keyof typeof EXPIRING)[]) {
      const table = EXPIRING[kind];
      const kept = KEPT[kind]?.(at.toISOString()) ?? sql``;
      const { rows } = await this.db.system((tx) =>
        tx.execute<{ shop_id: string; id: string }>(sql`
          SELECT shop_id, id FROM ${table}
           WHERE expires_at <= ${at.toISOString()} ${kept}
           ORDER BY expires_at
           LIMIT ${limit}`),
      );
      const byShop = new Map<string, string[]>();
      for (const row of rows) {
        const ids = byShop.get(row.shop_id);
        if (ids) ids.push(row.id);
        else byShop.set(row.shop_id, [row.id]);
      }
      for (const [shopId, ids] of byShop) {
        try {
          const { rows: gone } = await this.db.tenant(shopId, (tx) =>
            tx.execute(sql`
              DELETE FROM ${table}
               WHERE shop_id = ${shopId} AND id = ANY(${sql.param(ids)}::uuid[])
                 AND expires_at <= ${at.toISOString()} ${kept}
              RETURNING id`),
          );
          deleted[kind] += gone.length;
        } catch (error) {
          // One shop's failure is not the others': its rows are found again by the next sweep.
          if (!failed) throw error;
          failed(shopId, error);
        }
      }
    }
    deleted.wishlists = await this.#deleteUnsignedWishlists(at, limit, failed);
    return deleted;
  }

  /**
   * Deletes up to `limit` items of the wishlists numbers keep while no customer has them
   * (ADR-575), whose number no session lasting at `at` is signed in with, across shops: each
   * shop's in its own transaction, unless the number signed in again since. How many it deleted.
   */
  async #deleteUnsignedWishlists(
    at: Date,
    limit: number,
    failed?: (shopId: string, error: unknown) => void,
  ): Promise<number> {
    const unsigned = sql`
      NOT EXISTS (SELECT 1 FROM checkout.account_sessions session
                   WHERE session.shop_id = item.shop_id AND session.phone = item.phone
                     AND session.revoked_at IS NULL AND session.expires_at > ${at.toISOString()})`;
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; id: string }>(sql`
        SELECT item.shop_id, item.id FROM checkout.account_wishlist_items item
         WHERE item.phone IS NOT NULL AND ${unsigned}
         LIMIT ${limit}`),
    );
    const byShop = new Map<string, string[]>();
    for (const row of rows) byShop.set(row.shop_id, [...(byShop.get(row.shop_id) ?? []), row.id]);
    let deleted = 0;
    for (const [shopId, ids] of byShop) {
      try {
        const { rows: gone } = await this.db.tenant(shopId, (tx) =>
          tx.execute(sql`
            DELETE FROM checkout.account_wishlist_items item
             WHERE item.shop_id = ${shopId} AND item.id = ANY(${sql.param(ids)}::uuid[])
               AND item.phone IS NOT NULL AND ${unsigned}
            RETURNING item.id`),
        );
        deleted += gone.length;
      } catch (error) {
        if (!failed) throw error;
        failed(shopId, error);
      }
    }
    return deleted;
  }
}
