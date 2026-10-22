import type { Database } from '@hatti/db';
import type { ObjectStorage } from '@hatti/storage';
import { sql } from 'drizzle-orm';

// A closed shop's data deleted 90 days after its owner closed it (ADR-741), as Hatti's terms say
// (ADR-736): every table a shop's rows are kept in, found by the tenant isolation each has
// (ADR-003), but those the law has Hatti keep, and its files in storage. Its row in control.shops
// stays, closed, for what is kept to name.

/** How long after it closed a shop's data is deleted: the days its owner may still reopen it. */
export const CLOSED_SHOP_KEPT_DAYS = 90;

/**
 * The tables kept when a closed shop's data goes, with why: records the law has Hatti keep, such
 * as tax records, which are kept six years, and Hatti's own records of the shop. For counsel to
 * confirm (OWN-41); the sweep deletes nothing until `CLOSED_SHOP_PURGE` is on.
 */
export const KEPT_ON_CLOSING: Readonly<Record<string, string>> = {
  'control.shops': 'the shop itself, closed, for what is kept to name',
  'orders.orders': 'sales, for tax',
  'orders.lines': 'what each sale sold, for tax',
  'orders.order_invoices': 'invoices issued, for tax',
  'orders.refunds': 'money given back, for tax',
  'orders.refund_credit_notes': 'credit notes issued, for tax',
  'orders.returns': 'what came back, which refunds name',
  'orders.return_lines': 'what came back, line by line',
  'tax.fiscal_invoices': 'invoices reported to FBR, for tax',
  'billing.invoices': "Hatti's invoices to the shop, for tax",
  'billing.payments': 'what the shop paid Hatti, for tax',
  'billing.wallet_entries': "the shop's message credit with Hatti, for tax",
  'platform.audit_log': 'who did what, for security',
  'trust.reports': "Hatti's records of reports of the store",
  'trust.takedowns': "Hatti's records of taking the store down",
  'trust.appeals': "Hatti's records of the owner's appeals",
  'trust.rights_complaints': "Hatti's records of rights owners' complaints",
};

/** A table of a shop's, how many of its rows are kept or would go, and why kept. */
export interface ShopTable {
  table: string;
  rows: number;
  kept: string | null;
}

/** A closed shop whose data is due to go: closed `CLOSED_SHOP_KEPT_DAYS` ago, not yet purged. */
export interface DueShop {
  id: string;
  name: string;
  closedAt: Date;
}

/** What purging a shop did: rows deleted by table, and the tables whose rows could not go. */
export interface Purged {
  deleted: Record<string, number>;
  blocked: string[];
}

export class ClosedShopData {
  constructor(
    private readonly db: Database,
    private readonly storage?: ObjectStorage,
  ) {}

  /** The closed shops whose data is due to go at `at`, the longest closed first. */
  async due(at: Date = new Date(), limit = 20): Promise<DueShop[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ id: string; name: string; closed_at: Date | string }>(sql`
        SELECT id, name, closed_at FROM control.shops
         WHERE status = 'closed' AND purged_at IS NULL
           AND closed_at <= ${at.toISOString()}::timestamptz
                            - make_interval(days => ${CLOSED_SHOP_KEPT_DAYS})
         ORDER BY closed_at
         LIMIT ${limit}`),
    );
    return rows.map((row) => ({ id: row.id, name: row.name, closedAt: new Date(row.closed_at) }));
  }

  /** Every table holding the shop's rows, how many, and whether they are kept: what a purge does. */
  async report(shopId: string): Promise<ShopTable[]> {
    const tables = await this.#tables();
    const report: ShopTable[] = [];
    for (const table of tables) {
      const { rows } = await this.db.system((tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM ${sql.raw(table.name)}
               WHERE ${sql.raw(table.column)} = ${shopId}`,
        ),
      );
      const n = rows[0]?.n ?? 0;
      if (n > 0)
        report.push({ table: table.name, rows: n, kept: KEPT_ON_CLOSING[table.name] ?? null });
    }
    return report;
  }

  /**
   * Deletes the shop's rows from every table but those kept, and its files, once it has been
   * closed `CLOSED_SHOP_KEPT_DAYS` at `at`; then marks it purged. The tables are gone through until
   * a pass deletes nothing: a table whose rows another's still name goes on a later pass, as do rows
   * a delete's trigger adds, such as media to remove. A table left that could not go is reported,
   * and the shop not marked, for the next sweep to try again. Null for a shop not due.
   */
  async purge(shopId: string, at: Date = new Date()): Promise<Purged | null> {
    const [shop] = (await this.due(at, 1_000)).filter((each) => each.id === shopId);
    if (!shop) return null;
    const tables = (await this.#tables()).filter((table) => !(table.name in KEPT_ON_CLOSING));
    const deleted: Record<string, number> = {};
    for (;;) {
      const blocked: string[] = [];
      let gone = 0;
      for (const table of tables) {
        try {
          const { rows } = await this.db.system((tx) =>
            tx.execute<{ n: number }>(sql`
              WITH gone AS (
                DELETE FROM ${sql.raw(table.name)} WHERE ${sql.raw(table.column)} = ${shopId}
                RETURNING 1)
              SELECT count(*)::int AS n FROM gone`),
          );
          const n = rows[0]?.n ?? 0;
          if (n > 0) deleted[table.name] = (deleted[table.name] ?? 0) + n;
          gone += n;
        } catch (error) {
          // Another table's rows still name these: once those go, these can.
          if (errorCode(error) !== '23503') throw error;
          blocked.push(table.name);
        }
      }
      if (gone > 0) continue;
      if (blocked.length === 0) {
        await this.storage?.deletePrefix(`shops/${shopId}/`);
        await this.db.system((tx) =>
          tx.execute(sql`
            UPDATE control.shops SET purged_at = ${at.toISOString()}
             WHERE id = ${shopId} AND status = 'closed' AND purged_at IS NULL`),
        );
      }
      return { deleted, blocked };
    }
  }

  /** The tables a shop's rows are kept in: each with its tenant isolation, and the column it is by. */
  async #tables(): Promise<{ name: string; column: string }[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ name: string; column: string }>(sql`
        SELECT format('%I.%I', n.nspname, c.relname) AS name,
               CASE WHEN c.oid = 'control.shops'::regclass THEN 'id' ELSE 'shop_id' END AS column
          FROM pg_policy p
          JOIN pg_class c ON c.oid = p.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE p.polname = 'tenant_isolation'
           AND (c.oid = 'control.shops'::regclass OR EXISTS (
                 SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'shop_id' AND NOT a.attisdropped))
         ORDER BY 1`),
    );
    return rows;
  }
}

/** A Postgres error's code, on the error or on the one the driver wrapped. */
function errorCode(error: unknown): string | undefined {
  const each = error as { code?: unknown; cause?: { code?: unknown } };
  const code = each.code ?? each.cause?.code;
  return typeof code === 'string' ? code : undefined;
}
