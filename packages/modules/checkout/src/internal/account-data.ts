import { Database } from '@hatti/db';
import { ObjectStorage } from '@hatti/storage';
import { sql } from 'drizzle-orm';

/**
 * The files of their own data shoppers ask for from their accounts (CUS-05, ADR-572): the file the
 * shop's staff can give them (ADR-102), which storage keeps for a day behind links that last
 * minutes. Asked for again while it is kept, the same file is given: one a day.
 */
export const ACCOUNT_DATA = {
  /** How long storage keeps a file, given again until then: a day. */
  keepHours: 24,
  /** How long a link downloads it: a new one each time the shopper asks. */
  linkSeconds: 5 * 60,
  /** Files let go at a time by the worker's sweep, across shops. */
  batch: 100,
} as const;

/** What a file is, as storage keeps it. */
export const ACCOUNT_DATA_TYPE = 'application/json';

/** Where storage keeps file `id` of shop `shopId`. */
export function accountDataKey(shopId: string, id: string): string {
  return `shops/${shopId}/customer-data/${id}.json`;
}

/**
 * Lets go of shoppers' files once their day is up, or sooner, once their customer was merged into
 * another or erased (ADR-572): storage deletes each, then the shop forgets it. The worker's sweep
 * does it, as shoppers' requests never delete anything.
 */
export class AccountDataExpiry {
  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
  ) {}

  /**
   * Lets go of up to `limit` files whose time is up at `at`, the longest expired first, across
   * shops: found with the system role, each forgotten in its shop's own transaction once storage
   * deleted it. How many it let go. One that fails is told to `failed`, and found again by the
   * next sweep; without `failed`, its error is thrown.
   */
  async deleteExpired(
    at: Date = new Date(),
    limit: number = ACCOUNT_DATA.batch,
    failed?: (shopId: string, error: unknown) => void,
  ): Promise<number> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; id: string; key: string }>(sql`
        SELECT shop_id, id, key FROM checkout.account_data_exports
         WHERE expires_at <= ${at.toISOString()}
         ORDER BY expires_at
         LIMIT ${limit}`),
    );
    let deleted = 0;
    for (const row of rows) {
      try {
        await this.storage.delete(row.key);
        await this.db.tenant(row.shop_id, (tx) =>
          tx.execute(sql`
            DELETE FROM checkout.account_data_exports
             WHERE shop_id = ${row.shop_id} AND id = ${row.id}`),
        );
        deleted += 1;
      } catch (error) {
        if (!failed) throw error;
        failed(row.shop_id, error);
      }
    }
    return deleted;
  }
}
