import { Database } from '@hatti/db';
import { sql, type SQL } from 'drizzle-orm';

/** What expires, each in its table: checkouts first, so carts going after them update none. */
const EXPIRING = {
  checkouts: sql`checkout.checkouts`,
  carts: sql`checkout.carts`,
  proofs: sql`checkout.number_proofs`,
} as const satisfies Record<string, SQL>;

/** How many of each kind a sweep deleted. */
export type ExpiredCounts = Record<keyof typeof EXPIRING, number>;

/** Rows of each kind found past their time at a time, across shops. */
export const EXPIRY_BATCH = 1_000;

/**
 * The checkout module's rows past their time (ADR-042, ADR-230): checkouts, their codes with
 * them; carts; and browsers' proofs of a number (ADR-199). Nothing reads one once it has expired:
 * a secret naming a cart that is gone is never taken up, a checkout's page says it expired, and a
 * proof spares no code. The worker's sweep deletes them, so that shoppers' requests delete none,
 * and a shop that gets no new carts keeps no old ones.
 */
export class CheckoutExpiry {
  constructor(private readonly db: Database) {}

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
    const deleted: ExpiredCounts = { checkouts: 0, carts: 0, proofs: 0 };
    for (const kind of Object.keys(EXPIRING) as (keyof typeof EXPIRING)[]) {
      const table = EXPIRING[kind];
      const { rows } = await this.db.system((tx) =>
        tx.execute<{ shop_id: string; id: string }>(sql`
          SELECT shop_id, id FROM ${table}
           WHERE expires_at <= ${at.toISOString()}
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
                 AND expires_at <= ${at.toISOString()}
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
    return deleted;
  }
}
