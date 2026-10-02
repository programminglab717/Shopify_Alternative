import type { TenantContext } from '@hatti/api';
import { Database, exactTime, toDate, toDateOrNull } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  ConversionMomentValue,
  ConversionPlatformValue,
  ConversionStatusValue,
} from './meta.js';

/** A moment of an order, as the shop's list shows how sending it went. */
export interface ConversionRecord {
  id: string;
  platform: ConversionPlatformValue;
  orderId: string;
  moment: ConversionMomentValue;
  occurredAt: Date;
  status: ConversionStatusValue;
  /** The name it went by once sent. */
  eventName: string | null;
  attempts: number;
  sentAt: Date | null;
  error: string | null;
  traceId: string | null;
  createdAt: Date;
  /** When it was recorded, to the microsecond: where the next page starts. */
  createdAtExactly: string;
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}

export interface ConversionsListOptions {
  first: number;
  /** The last one of the page before: the next page starts after it. */
  after: { id: string; createdAt: string } | null;
  status?: ConversionStatusValue | null;
  orderId?: string | null;
}

/** A moment the sender took to send. */
export interface ClaimedConversion {
  id: string;
  platform: ConversionPlatformValue;
  orderId: string;
  moment: ConversionMomentValue;
  occurredAt: Date;
  /** Tries so far, this one among them. */
  attempts: number;
}

/** How sending a claimed moment went. */
export type ConversionOutcome =
  | { id: string; status: 'sent'; eventName: string; traceId: string | null }
  | { id: string; status: 'pending'; error: string; traceId: string | null; nextAttemptAt: Date }
  | {
      id: string;
      status: 'failed';
      eventName: string | null;
      error: string;
      traceId: string | null;
    }
  | { id: string; status: 'expired' | 'skipped'; error: string };

type ConversionRow = {
  id: string;
  platform: ConversionPlatformValue;
  order_id: string;
  moment: ConversionMomentValue;
  occurred_at: string | Date;
  status: ConversionStatusValue;
  event_name: string | null;
  attempts: number;
  sent_at: string | Date | null;
  error: string | null;
  trace_id: string | null;
  created_at: string | Date;
  created_at_exactly: string;
};

/**
 * The moments of orders that go to the ad platforms a shop connects (MKT-10, ADR-143), each
 * waiting in Postgres until a sender in the worker sends it: an order placed through checkout
 * as it is placed, and then as it is confirmed and delivered, once each. A moment is tried again
 * while the platform cannot take it yet, and given up when it is too old to go.
 */
@Injectable()
export class ConversionsService {
  constructor(private readonly db: Database) {}

  /**
   * Records an order's placing, once, for each platform its shop has connected: how many it was
   * recorded for.
   */
  async recordPlaced(shopId: string, orderId: string, occurredAt: Date): Promise<number> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO marketing.conversions (shop_id, platform, order_id, moment, occurred_at)
        SELECT shop_id, 'meta', ${orderId}, 'placed', ${occurredAt.toISOString()}
          FROM marketing.meta_settings
         WHERE shop_id = ${shopId}
            ON CONFLICT DO NOTHING
        RETURNING id`);
      return rows.length;
    });
  }

  /**
   * Records an order's later moment, once, for each platform its placing was recorded for: its
   * shop's orders from before it connected one go to it never.
   */
  async recordAfterPlaced(
    shopId: string,
    orderId: string,
    moment: Exclude<ConversionMomentValue, 'placed'>,
    occurredAt: Date,
  ): Promise<number> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO marketing.conversions (shop_id, platform, order_id, moment, occurred_at)
        SELECT shop_id, platform, order_id, ${moment}, ${occurredAt.toISOString()}
          FROM marketing.conversions
         WHERE shop_id = ${shopId} AND order_id = ${orderId} AND moment = 'placed'
            ON CONFLICT DO NOTHING
        RETURNING id`);
      return rows.length;
    });
  }

  /** Whether the order's placing was recorded for any platform. */
  async placedRecorded(shopId: string, orderId: string): Promise<boolean> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ found: boolean }>(sql`
        SELECT EXISTS (SELECT 1 FROM marketing.conversions
                        WHERE shop_id = ${shopId} AND order_id = ${orderId}
                          AND moment = 'placed') AS found`);
      return rows[0]?.found ?? false;
    });
  }

  /** The shops with moments due to go at `at`: found with the system role, which sees all. */
  async dueShops(at: Date, limit = 100): Promise<string[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT shop_id FROM marketing.conversions
         WHERE status = 'pending' AND next_attempt_at <= ${at.toISOString()}
         LIMIT ${limit}`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * Takes up to `limit` of the shop's moments due at `at`, the longest due first, to send them:
   * each counts a try, and is not due again for `leaseMs` unless settled before. No two senders
   * take the same, and one that stops before settling has them sent again after that.
   */
  async claim(
    shopId: string,
    at: Date,
    limit: number,
    leaseMs: number,
  ): Promise<ClaimedConversion[]> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        platform: ConversionPlatformValue;
        order_id: string;
        moment: ConversionMomentValue;
        occurred_at: string | Date;
        attempts: number;
      }>(sql`
        -- Chosen once: a subquery in UPDATE's FROM may be run again, and take more.
        WITH due AS MATERIALIZED (
          SELECT id FROM marketing.conversions
           WHERE shop_id = ${shopId} AND status = 'pending'
             AND next_attempt_at <= ${at.toISOString()}
           ORDER BY next_attempt_at, id
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED)
        UPDATE marketing.conversions c
           SET attempts = c.attempts + 1,
               next_attempt_at = ${new Date(at.getTime() + leaseMs).toISOString()}
          FROM due
         WHERE c.shop_id = ${shopId} AND c.id = due.id
        RETURNING c.id, c.platform, c.order_id, c.moment, c.occurred_at, c.attempts`);
      return rows
        .map((row) => ({
          id: row.id,
          platform: row.platform,
          orderId: row.order_id,
          moment: row.moment,
          occurredAt: toDate(row.occurred_at),
          attempts: row.attempts,
        }))
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : 1));
    });
  }

  /** Settles claimed moments as sending them went, at `at`. */
  async settle(shopId: string, outcomes: readonly ConversionOutcome[], at: Date): Promise<void> {
    if (outcomes.length === 0) return;
    await this.db.tenant(shopId, async (tx) => {
      for (const outcome of outcomes) {
        const set =
          outcome.status === 'sent'
            ? sql`status = 'sent', sent_at = ${at.toISOString()}, event_name = ${outcome.eventName},
                  trace_id = ${outcome.traceId}, error = NULL`
            : outcome.status === 'pending'
              ? sql`next_attempt_at = ${outcome.nextAttemptAt.toISOString()},
                    error = ${outcome.error.slice(0, 1_000)}, trace_id = ${outcome.traceId}`
              : outcome.status === 'failed'
                ? sql`status = 'failed', event_name = ${outcome.eventName},
                      error = ${outcome.error.slice(0, 1_000)}, trace_id = ${outcome.traceId}`
                : sql`status = ${outcome.status}, error = ${outcome.error.slice(0, 1_000)}`;
        await tx.execute(sql`
          UPDATE marketing.conversions SET ${set}
           WHERE shop_id = ${shopId} AND id = ${outcome.id} AND status = 'pending'`);
      }
    });
  }

  /** The shop's moments, the latest first, a page at a time. */
  async list(
    tenant: TenantContext,
    options: ConversionsListOptions,
  ): Promise<Page<ConversionRecord>> {
    const { after, status, orderId } = options;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<ConversionRow>(sql`
        SELECT id, platform, order_id, moment, occurred_at, status, event_name, attempts, sent_at,
               error, trace_id, created_at, ${exactTime(sql`created_at`)} AS created_at_exactly
          FROM marketing.conversions
         WHERE shop_id = ${tenant.shopId}
           ${status ? sql`AND status = ${status}` : sql``}
           ${orderId ? sql`AND order_id = ${orderId}` : sql``}
           ${
             after
               ? sql`AND (created_at, id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
               : sql``
           }
         ORDER BY created_at DESC, id DESC
         LIMIT ${options.first + 1}`);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }
}

function toRecord(row: ConversionRow): ConversionRecord {
  return {
    id: row.id,
    platform: row.platform,
    orderId: row.order_id,
    moment: row.moment,
    occurredAt: toDate(row.occurred_at),
    status: row.status,
    eventName: row.event_name,
    attempts: row.attempts,
    sentAt: toDateOrNull(row.sent_at),
    error: row.error,
    traceId: row.trace_id,
    createdAt: toDate(row.created_at),
    createdAtExactly: row.created_at_exactly,
  };
}
