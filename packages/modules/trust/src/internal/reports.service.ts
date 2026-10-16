import { createHash } from 'node:crypto';
import { InputChecker, type MutationResult } from '@hatti/api';
import { Database, toDate, toDateOrNull } from '@hatti/db';
import { isUuid } from '@hatti/ids';
import { parsePkMobile } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Shoppers' reports of stores (TNS-01, ADR-460): sent from the link in every store's footer, kept
// for Hatti's people, each due a decision within 48 hours, dismissed or upheld with what was
// done. The shop never sees who reported it, nor any report through its own API.

export const REPORT_REASONS = [
  'never_delivered',
  'not_as_described',
  'counterfeit',
  'prohibited',
  'scam',
  'impersonation',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ['open', 'dismissed', 'upheld'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_LIMITS = {
  /** A decision is due this long after a report comes. */
  dueMs: 48 * 3_600_000,
  details: 2000,
  orderName: 40,
  pageUrl: 500,
  /** Reports of one store from one address a day, past which more are not taken. */
  perClientPerDay: 3,
} as const;

/** What a shopper sends from the report page. */
export interface ReportInput {
  reason: string | null;
  details: string | null;
  phone?: string | null;
  orderName?: string | null;
  pageUrl?: string | null;
  /** The shopper's address, kept only as a hash with the shop's. */
  client?: string | null;
  language?: 'en' | 'ur';
}

/** A report, as Hatti's people see it. */
export interface ReportRecord {
  id: string;
  shopId: string;
  shopName: string;
  shopHandle: string;
  reason: ReportReason;
  details: string;
  /** E.164, where the shopper gave one. */
  phone: string | null;
  orderName: string | null;
  pageUrl: string | null;
  language: 'en' | 'ur';
  status: ReportStatus;
  dueAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  decision: string | null;
  createdAt: Date;
  /** Open reports of the same store, this one among them. */
  openOfShop: number;
}

type ReportRow = {
  id: string;
  shop_id: string;
  shop_name: string;
  shop_handle: string;
  reason: ReportReason;
  details: string;
  phone: string | null;
  order_name: string | null;
  page_url: string | null;
  language: 'en' | 'ur';
  status: ReportStatus;
  due_at: string | Date;
  decided_at: string | Date | null;
  decided_by: string | null;
  decision: string | null;
  created_at: string | Date;
  open_of_shop: number;
};

const SELECT = sql`
  SELECT r.id, r.shop_id, s.name AS shop_name, s.handle AS shop_handle, r.reason, r.details,
         r.phone, r.order_name, r.page_url, r.language, r.status, r.due_at, r.decided_at,
         r.decided_by, r.decision, r.created_at,
         (SELECT count(*)::int FROM trust.reports o
           WHERE o.shop_id = r.shop_id AND o.status = 'open') AS open_of_shop
    FROM trust.reports r
    JOIN control.shops s ON s.id = r.shop_id`;

/** What became of a decision asked for. */
export type ReportDecided = ReportRecord | 'not_found' | 'decided';

/** The shopper's address, hashed with the shop's: the same person, not who. */
function clientHash(shopId: string, client: string): string {
  return createHash('sha256').update(`${shopId}:${client}`).digest('hex').slice(0, 32);
}

@Injectable()
export class ReportsService {
  constructor(private readonly db: Database) {}

  /**
   * Takes a shopper's report of the shop: what is wrong, in their words, and how to reach them if
   * they say; due a decision in 48 hours. One address reports one store three times a day at most.
   */
  async report(
    shopId: string,
    input: ReportInput,
    now: Date = new Date(),
  ): Promise<MutationResult<{ id: string }>> {
    const check = new InputChecker();
    const reason = input.reason?.trim() ?? '';
    if (!(REPORT_REASONS as readonly string[]).includes(reason)) {
      check.addMessage(['reason'], 'INVALID', 'Say what is wrong');
    }
    const details = check.text(['details'], input.details, {
      max: REPORT_LIMITS.details,
      required: true,
    });
    let phone: string | null = null;
    if (input.phone?.trim()) {
      phone = parsePkMobile(input.phone)?.e164 ?? null;
      if (!phone) check.addMessage(['phone'], 'INVALID', 'Enter a Pakistani mobile number');
    }
    const orderName = check.text(['orderName'], input.orderName, {
      max: REPORT_LIMITS.orderName,
    });
    if (!check.ok || !details) return { ok: false, errors: check.errors };
    const pageUrl = input.pageUrl?.slice(0, REPORT_LIMITS.pageUrl) || null;
    const hash = input.client ? clientHash(shopId, input.client) : null;

    return this.db.tenant(shopId, async (tx) => {
      const { rows: shops } = await tx.execute<{ id: string }>(
        sql`SELECT id FROM control.shops WHERE id = ${shopId}`,
      );
      if (shops.length === 0) {
        return {
          ok: false,
          errors: [{ field: ['base'], code: 'NOT_FOUND', message: 'No such store' }],
        };
      }
      if (hash) {
        const { rows } = await tx.execute<{ count: number }>(sql`
          SELECT count(*)::int AS count FROM trust.reports
           WHERE shop_id = ${shopId} AND client_hash = ${hash}
             AND created_at > ${new Date(now.getTime() - 86_400_000).toISOString()}`);
        if (rows[0]!.count >= REPORT_LIMITS.perClientPerDay) {
          return {
            ok: false,
            errors: [
              {
                field: ['base'],
                code: 'INVALID',
                message: 'You have reported this store today already: Hatti is looking into it',
              },
            ],
          };
        }
      }
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO trust.reports
               (shop_id, reason, details, phone, order_name, page_url, client_hash, language,
                due_at, created_at)
        VALUES (${shopId}, ${reason}, ${details}, ${phone}, ${orderName}, ${pageUrl}, ${hash},
                ${input.language ?? 'en'},
                ${new Date(now.getTime() + REPORT_LIMITS.dueMs).toISOString()},
                ${now.toISOString()})
        RETURNING id`);
      return { ok: true, value: { id: rows[0]!.id } };
    });
  }

  /**
   * Reports for Hatti's people, with the system login, which sees every shop's: those open, the
   * soonest due first, or all, the latest first.
   */
  async list(options: { all?: boolean; limit?: number } = {}): Promise<ReportRecord[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<ReportRow>(sql`
        ${SELECT}
         ${options.all ? sql`` : sql`WHERE r.status = 'open'`}
         ORDER BY ${options.all ? sql`r.created_at DESC` : sql`r.due_at`}, r.id
         LIMIT ${options.limit ?? 100}`),
    );
    return rows.map(toRecord);
  }

  /** A report's decision by Hatti's people: dismissed, or upheld with what was done. Once. */
  async decide(
    id: string,
    decision: { status: 'dismissed' | 'upheld'; by: string; note: string },
    now: Date = new Date(),
  ): Promise<ReportDecided> {
    if (!isUuid(id)) return 'not_found';
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE trust.reports
           SET status = ${decision.status}, decided_at = ${now.toISOString()},
               decided_by = ${decision.by.slice(0, 100)},
               decision = ${decision.note.slice(0, 1000)}
         WHERE id = ${id} AND status = 'open'
        RETURNING id`);
      if (rows.length === 0) {
        const { rows: found } = await tx.execute<{ id: string }>(
          sql`SELECT id FROM trust.reports WHERE id = ${id}`,
        );
        return found.length === 0 ? 'not_found' : 'decided';
      }
      const { rows: decided } = await tx.execute<ReportRow>(sql`${SELECT} WHERE r.id = ${id}`);
      return toRecord(decided[0]!);
    });
  }
}

function toRecord(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    shopName: row.shop_name,
    shopHandle: row.shop_handle,
    reason: row.reason,
    details: row.details,
    phone: row.phone,
    orderName: row.order_name,
    pageUrl: row.page_url,
    language: row.language,
    status: row.status,
    dueAt: toDate(row.due_at),
    decidedAt: toDateOrNull(row.decided_at),
    decidedBy: row.decided_by,
    decision: row.decision,
    createdAt: toDate(row.created_at),
    openOfShop: row.open_of_shop,
  };
}
