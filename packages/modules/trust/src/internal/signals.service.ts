import { Database, toDate, toDateOrNull } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Signs of a scam store (TNS-02, ADR-842): what scam stores here do, looked for across stores
// each day, for Hatti's people to look into before shoppers report them. Nothing is done to a
// store by a sign alone: Hatti's people take it down (ADR-461), or clear the sign.

export const SIGNAL_KINDS = ['prepaid_unshipped', 'cloned_catalogue', 'impersonation'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SIGNAL_RULES = {
  /** Stores younger than this are looked at: scams open, take money and vanish. */
  youngDays: 90,
  /** An order paid in advance and not shipped this long after it was placed is kept waiting. */
  unshippedDays: 5,
  /** So many such orders make a sign. */
  unshippedOrders: 5,
  /** So many of a store's photos or titles the same as an older store's make a sign... */
  clonedItems: 5,
  /** ...when they are this share of its own, in percent. */
  clonedShare: 50,
  /** Characters a name may differ by from a verified store's and still read as it. */
  nameDistance: 1,
  /** Shortest name compared: short names are alike by chance. */
  shortestName: 4,
} as const;

export const SIGNAL_LIMITS = { note: 1000, by: 100 } as const;

/** A sign, as Hatti's people see it. */
export interface StoreSignalRecord {
  shopId: string;
  shopName: string;
  shopHandle: string;
  kind: SignalKind;
  detail: Record<string, unknown>;
  firstSeenAt: Date;
  lastSeenAt: Date;
  clearedAt: Date | null;
  clearedBy: string | null;
  note: string | null;
}

/** A sign found in a scan. */
interface Found {
  shopId: string;
  kind: SignalKind;
  detail: Record<string, unknown>;
}

/** Words shops add to a name that say nothing of whose it is. */
const FILLER = /\b(official|store|shop|online|pk|pakistan|the|by|brand|collection|outlet)\b/g;

/** A store's name as compared: its letters and digits alone, filler words left out. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(FILLER, ' ')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Whether two names' keys are at most `most` edits apart. */
export function withinEdits(a: string, b: string, most: number): boolean {
  if (Math.abs(a.length - b.length) > most) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      best = Math.min(best, current[j]!);
    }
    if (best > most) return false;
    previous = current;
  }
  return previous[b.length]! <= most;
}

@Injectable()
export class StoreSignalsService {
  constructor(private readonly db: Database) {}

  /**
   * Looks across stores for each kind of sign, keeping each found, its detail and when it was
   * last seen, once a store and kind; one cleared stays cleared. How many signs stand.
   */
  async scan(at: Date = new Date()): Promise<number> {
    const found = [
      ...(await this.#prepaidUnshipped(at)),
      ...(await this.#clonedCatalogues(at)),
      ...(await this.#impersonations(at)),
    ];
    await this.db.system(async (tx) => {
      for (const each of found) {
        await tx.execute(sql`
          INSERT INTO trust.store_signals (shop_id, kind, detail, first_seen_at, last_seen_at)
               VALUES (${each.shopId}, ${each.kind}, ${JSON.stringify(each.detail)}::jsonb,
                       ${at.toISOString()}, ${at.toISOString()})
          ON CONFLICT (shop_id, kind) DO UPDATE
                SET detail = EXCLUDED.detail, last_seen_at = EXCLUDED.last_seen_at
              WHERE trust.store_signals.cleared_at IS NULL`);
      }
    });
    return found.length;
  }

  /**
   * Young stores keeping customers' money for orders they don't ship: orders paid in advance,
   * by transfer or online, placed days ago, neither shipped nor cancelled nor refunded.
   */
  async #prepaidUnshipped(at: Date): Promise<Found[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; orders: number; total: string; oldest: string }>(sql`
        SELECT o.shop_id, count(*)::int AS orders, sum(o.total)::text AS total,
               min(o.created_at) AS oldest
          FROM orders.orders o
          JOIN control.shops s ON s.id = o.shop_id
         WHERE s.created_at > ${at.toISOString()}::timestamptz
                              - make_interval(days => ${SIGNAL_RULES.youngDays})
           AND o.payment_method IN ('bank_transfer', 'online')
           AND o.financial_status IN ('paid', 'partially_paid')
           AND o.fulfillment_status = 'unfulfilled'
           AND o.cancelled_at IS NULL
           AND o.created_at < ${at.toISOString()}::timestamptz
                              - make_interval(days => ${SIGNAL_RULES.unshippedDays})
         GROUP BY o.shop_id
        HAVING count(*) >= ${SIGNAL_RULES.unshippedOrders}`),
    );
    return rows.map((row) => ({
      shopId: row.shop_id,
      kind: 'prepaid_unshipped' as const,
      detail: { orders: row.orders, total: row.total, oldest: toDate(row.oldest).toISOString() },
    }));
  }

  /**
   * Young stores whose catalogue is another, older store's: photos the same to the byte and the
   * pixel, as a copy's are, or titles word for word, so many and so much of its own.
   */
  async #clonedCatalogues(at: Date): Promise<Found[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; other_id: string; same: number; own: number; by: string }>(sql`
        WITH young AS (
          SELECT id, created_at FROM control.shops
           WHERE created_at > ${at.toISOString()}::timestamptz
                              - make_interval(days => ${SIGNAL_RULES.youngDays})
        ),
        photos AS (
          SELECT m.shop_id, other.shop_id AS other_id, count(DISTINCT m.id)::int AS same
            FROM catalog.product_media m
            JOIN young y ON y.id = m.shop_id
            JOIN catalog.product_media other
              ON other.image_size = m.image_size AND other.width = m.width
             AND other.height = m.height AND other.shop_id <> m.shop_id
            JOIN control.shops os ON os.id = other.shop_id AND os.created_at < y.created_at
           WHERE m.image_size IS NOT NULL AND m.width IS NOT NULL
           GROUP BY m.shop_id, other.shop_id
        ),
        titles AS (
          SELECT p.shop_id, other.shop_id AS other_id, count(DISTINCT p.id)::int AS same
            FROM catalog.products p
            JOIN young y ON y.id = p.shop_id
            JOIN catalog.products other
              ON lower(other.title) = lower(p.title) AND other.shop_id <> p.shop_id
            JOIN control.shops os ON os.id = other.shop_id AND os.created_at < y.created_at
           GROUP BY p.shop_id, other.shop_id
        ),
        own AS (
          SELECT shop_id,
                 (SELECT count(*) FROM catalog.product_media m
                   WHERE m.shop_id = y.id AND m.image_size IS NOT NULL)::int AS photos,
                 (SELECT count(*) FROM catalog.products p WHERE p.shop_id = y.id)::int AS products
            FROM (SELECT id AS shop_id, id FROM young) y
        )
        SELECT DISTINCT ON (c.shop_id) c.shop_id, c.other_id, c.same, c.own, c.by
          FROM (
            SELECT ph.shop_id, ph.other_id, ph.same, o.photos AS own, 'photos' AS by
              FROM photos ph JOIN own o ON o.shop_id = ph.shop_id
            UNION ALL
            SELECT t.shop_id, t.other_id, t.same, o.products AS own, 'titles' AS by
              FROM titles t JOIN own o ON o.shop_id = t.shop_id
          ) c
         WHERE c.same >= ${SIGNAL_RULES.clonedItems}
           AND c.same * 100 >= c.own * ${SIGNAL_RULES.clonedShare}
         ORDER BY c.shop_id, c.same DESC`),
    );
    return rows.map((row) => ({
      shopId: row.shop_id,
      kind: 'cloned_catalogue' as const,
      detail: { otherShopId: row.other_id, by: row.by, same: row.same, own: row.own },
    }));
  }

  /** Young stores, not verified themselves, whose name reads as a verified store's. */
  async #impersonations(at: Date): Promise<Found[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ id: string; name: string; verified: boolean; young: boolean }>(sql`
        SELECT s.id, s.name,
               EXISTS (SELECT 1 FROM trust.verifications v
                        WHERE v.shop_id = s.id AND v.status = 'approved') AS verified,
               s.created_at > ${at.toISOString()}::timestamptz
                              - make_interval(days => ${SIGNAL_RULES.youngDays}) AS young
          FROM control.shops s
         WHERE s.status = 'active'`),
    );
    const verified = rows
      .filter((row) => row.verified)
      .map((row) => ({ id: row.id, name: row.name, key: nameKey(row.name) }))
      .filter((row) => row.key.length >= SIGNAL_RULES.shortestName);
    const found: Found[] = [];
    for (const row of rows) {
      if (row.verified || !row.young) continue;
      const key = nameKey(row.name);
      if (key.length < SIGNAL_RULES.shortestName) continue;
      const like = verified.find(
        (each) => each.id !== row.id && withinEdits(key, each.key, SIGNAL_RULES.nameDistance),
      );
      if (like) {
        found.push({
          shopId: row.id,
          kind: 'impersonation',
          detail: { verifiedShopId: like.id, verifiedName: like.name, name: row.name },
        });
      }
    }
    return found;
  }

  /** The signs standing, the latest seen first; with `all`, those cleared too. */
  async list(options: { all?: boolean } = {}): Promise<StoreSignalRecord[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{
        shop_id: string;
        name: string;
        handle: string;
        kind: SignalKind;
        detail: Record<string, unknown>;
        first_seen_at: string;
        last_seen_at: string;
        cleared_at: string | null;
        cleared_by: string | null;
        note: string | null;
      }>(sql`
        SELECT g.shop_id, s.name, s.handle, g.kind, g.detail, g.first_seen_at, g.last_seen_at,
               g.cleared_at, g.cleared_by, g.note
          FROM trust.store_signals g
          JOIN control.shops s ON s.id = g.shop_id
         WHERE ${options.all ? sql`true` : sql`g.cleared_at IS NULL`}
         ORDER BY g.last_seen_at DESC, g.shop_id, g.kind`),
    );
    return rows.map((row) => ({
      shopId: row.shop_id,
      shopName: row.name,
      shopHandle: row.handle,
      kind: row.kind,
      detail: row.detail,
      firstSeenAt: toDate(row.first_seen_at),
      lastSeenAt: toDate(row.last_seen_at),
      clearedAt: toDateOrNull(row.cleared_at),
      clearedBy: row.cleared_by,
      note: row.note,
    }));
  }

  /**
   * Clears a sign Hatti's people looked into and found nothing wrong in, by its store's handle:
   * it isn't raised again for that store. Whether one stood.
   */
  async clear(handle: string, kind: SignalKind, by: string, note: string): Promise<boolean> {
    const who = by.trim().slice(0, SIGNAL_LIMITS.by);
    const why = note.trim().slice(0, SIGNAL_LIMITS.note);
    if (!who || !why) throw new Error('Say who clears it, and why');
    const { rows } = await this.db.system((tx) =>
      tx.execute(sql`
        UPDATE trust.store_signals g
           SET cleared_at = now(), cleared_by = ${who}, note = ${why}
          FROM control.shops s
         WHERE s.id = g.shop_id AND s.handle = ${handle} AND g.kind = ${kind}
           AND g.cleared_at IS NULL
        RETURNING g.shop_id`),
    );
    return rows.length > 0;
  }
}
