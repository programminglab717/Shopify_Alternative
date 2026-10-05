import {
  InputChecker,
  actorColumnsOf,
  failOne,
  shopProfile,
  type MutationResult,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import type { CurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  exportPeriod,
  periodFilename,
  scheduledExportEmail,
  type ExportFrequencyValue,
  type ExportPeriod,
  type ScheduledExportSender,
} from './export-schedule-email.js';
import {
  EXPORT_ROLES,
  OrderExportService,
  type ExportFormatValue,
  type ExportLayoutValue,
} from './order-export.service.js';
import { parseOrderSearch } from './order-filter.js';

// Exports a member of staff schedules (ORD-11, ADR-183): every day, week or month, the orders
// placed in the one that just ended, filtered as the order list is, as CSV or an Excel workbook,
// emailed to them as an attachment at the hour they chose, in the shop's time zone. Each
// schedule names its member by their account; whom it goes to is asked of identity as it is
// sent, so that one who left the shop, may no longer export, or has no proved email, gets
// nothing. The worker sends them.

export { EXPORT_FREQUENCIES, type ExportFrequencyValue } from './export-schedule-email.js';

export const EXPORT_SCHEDULE_LIMITS = {
  /** Schedules a shop keeps. */
  perShop: 20,
  /** The hour it goes, unless said: the start of the working day. */
  hour: 8,
  /** How long a try holds a schedule before another worker may take it. */
  leaseMs: 10 * 60_000,
  /**
   * A period the email service can't take within a day of its time is given up. One missed while
   * the worker was down still goes when it is back: it is a file of its own.
   */
  giveUpMs: 24 * 3_600_000,
} as const;

export interface ExportScheduleInput {
  frequency: ExportFrequencyValue;
  /** The hour of the day it goes, 0 to 23 in the shop's time zone. */
  hour?: number | null;
  layout: ExportLayoutValue;
  format: ExportFormatValue;
  /** As orders(query:) takes it; none for every order. */
  query?: string | null;
}

export interface ExportScheduleRecord {
  id: string;
  /** The member of staff it goes to, by their account's ID. */
  userId: string;
  frequency: ExportFrequencyValue;
  hour: number;
  layout: ExportLayoutValue;
  format: ExportFormatValue;
  query: string;
  /** When it next goes, and the period it sends then. */
  nextRunAt: Date;
  nextPeriod: ExportPeriod;
  lastSentAt: Date | null;
  /** Why the last period went unsent, or its last try failed. */
  lastError: string | null;
  createdAt: Date;
}

/** How a schedule's try went: none when it was not due, or another worker had it. */
export type ExportRunOutcome = 'sent' | 'retry' | 'skipped' | 'none';

type ScheduleRow = {
  id: string;
  user_id: string;
  frequency: ExportFrequencyValue;
  hour: number;
  layout: ExportLayoutValue;
  format: ExportFormatValue;
  query: string;
  period_end: string;
  next_run_at: string | Date;
  attempts: number;
  last_sent_at: string | Date | null;
  last_error: string | null;
  created_at: string | Date;
};

/** A schedule's columns as a row has them: its period's end as text, a day of no time zone. */
const COLUMNS = sql.raw(
  'id, user_id, frequency, hour, layout, format, query, period_end::text AS period_end, ' +
    'next_run_at, attempts, last_sent_at, last_error, created_at',
);

/** What date_trunc and intervals call each frequency's period. */
const UNITS: Record<ExportFrequencyValue, 'day' | 'week' | 'month'> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

/** Whom a scheduled export goes to, as identity knows them now. */
interface Recipient {
  email: string;
  name: string;
  role: StaffRole;
}

@Injectable()
export class ExportScheduleService {
  constructor(
    private readonly db: Database,
    private readonly exports: OrderExportService,
  ) {}

  /**
   * Schedules an export for the member of staff asking, to their proved email: its first period
   * the one whose end has its hour still to come.
   */
  async create(
    tenant: TenantContext,
    input: ExportScheduleInput,
    at: Date = new Date(),
  ): Promise<MutationResult<ExportScheduleRecord>> {
    const { actor } = tenant;
    if (actor.kind !== 'staff') {
      return failOne(['input'], 'INVALID', 'Only staff schedule exports: each goes to their email');
    }
    if (!EXPORT_ROLES.includes(actor.role)) {
      return failOne(['input'], 'INVALID', 'Only owners, managers and accountants export orders');
    }
    const check = new InputChecker();
    const hour = input.hour ?? EXPORT_SCHEDULE_LIMITS.hour;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      check.add(['input', 'hour'], 'INVALID', 'must be an hour of the day, 0 to 23');
    }
    const query = input.query?.trim() ?? '';
    if (query.length > 1_000) {
      check.add(['input', 'query'], 'TOO_LONG', 'is too long (maximum is 1000 characters)');
    } else {
      const parsed = parseOrderSearch(query);
      if (!parsed.ok) check.addMessage(['input', 'query'], 'INVALID', parsed.error);
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    const unit = UNITS[input.frequency];
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { shopId } = tenant;
      if (!(await recipientIn(tx, shopId, actor.userId))) {
        return failOne(
          ['input'],
          'INVALID',
          "Prove your account's email first: scheduled exports are emailed to it",
        );
      }
      // Counted under a lock, so that two made at once can't both pass the limit.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`export_schedules:${shopId}`}, 0))`,
      );
      const { rows: counted } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM orders.export_schedules WHERE shop_id = ${shopId}`);
      if (counted[0]!.count >= EXPORT_SCHEDULE_LIMITS.perShop) {
        return failOne(
          ['input'],
          'TOO_MANY',
          `A shop keeps at most ${EXPORT_SCHEDULE_LIMITS.perShop} scheduled exports`,
        );
      }
      const { timezone } = await shopProfile(tx, shopId);
      // Its first period ends at the start of this day, week or month, if its hour is still to
      // come; at the start of the next otherwise.
      const { rows } = await tx.execute<ScheduleRow>(sql`
        WITH local AS (SELECT ${at.toISOString()}::timestamptz AT TIME ZONE ${timezone} AS now),
             start AS (SELECT date_trunc(${unit}, now) AS boundary, now FROM local),
             first AS (
               SELECT CASE WHEN boundary + make_interval(hours => ${hour}) > now
                           THEN boundary::date
                           ELSE (boundary + ${`1 ${unit}`}::interval)::date END AS period_end
                 FROM start)
        INSERT INTO orders.export_schedules
               (shop_id, id, user_id, frequency, hour, layout, format, query, period_end,
                next_run_at)
        SELECT ${shopId}, ${newId()}, ${actor.userId}, ${input.frequency}, ${hour},
               ${input.layout}, ${input.format}, ${query}, period_end,
               (period_end::timestamp + make_interval(hours => ${hour})) AT TIME ZONE ${timezone}
          FROM first
        RETURNING ${COLUMNS}`);
      const schedule = toRecord(rows[0]!);
      await recordAudit(tx, shopId, {
        action: 'orders.export_scheduled',
        subjectType: 'exportSchedule',
        subjectId: schedule.id,
        ...actorColumnsOf(actor),
        details: {
          frequency: schedule.frequency.toUpperCase(),
          hour,
          layout: schedule.layout.toUpperCase(),
          format: schedule.format.toUpperCase(),
          query: query || null,
        },
      });
      return { ok: true, value: schedule };
    });
  }

  /** The shop's scheduled exports, the newest first. */
  async list(tenant: TenantContext): Promise<ExportScheduleRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<ScheduleRow>(sql`
        SELECT ${COLUMNS} FROM orders.export_schedules
         WHERE shop_id = ${tenant.shopId}
         ORDER BY created_at DESC, id DESC`);
      return rows.map(toRecord);
    });
  }

  /**
   * Deletes a scheduled export: a member of staff's own, or any for owners, managers and apps.
   * Its ID.
   */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<string>> {
    const { actor } = tenant;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const mine =
        actor.kind === 'staff' && actor.role !== 'owner' && actor.role !== 'manager'
          ? sql`AND user_id = ${actor.userId}`
          : sql``;
      const { rows } = await tx.execute<{ id: string; user_id: string }>(sql`
        DELETE FROM orders.export_schedules
         WHERE shop_id = ${tenant.shopId} AND id = ${id} ${mine}
        RETURNING id, user_id`);
      if (!rows[0]) return failOne(['id'], 'NOT_FOUND', 'Scheduled export not found');
      await recordAudit(tx, tenant.shopId, {
        action: 'orders.export_unscheduled',
        subjectType: 'exportSchedule',
        subjectId: id,
        ...actorColumnsOf(actor),
        details: { staffMember: toPublicId('user', rows[0].user_id) },
      });
      return { ok: true, value: id };
    });
  }

  /** The schedules due at `at`, across shops, the longest due first: found with the system role. */
  async due(at: Date, limit = 50): Promise<{ shopId: string; id: string }[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; id: string }>(sql`
        SELECT shop_id, id FROM orders.export_schedules
         WHERE next_run_at <= ${at.toISOString()}
         ORDER BY next_run_at
         LIMIT ${limit}`),
    );
    return rows.map((row) => ({ shopId: row.shop_id, id: row.id }));
  }

  /**
   * Sends schedule `id`'s export of its period through `sender`, if it is due at `at`: as the
   * member of staff it goes to, who must still work in the shop in a role that exports orders,
   * with a proved email. The period sent, or given up, the next is due at the schedule's hour
   * once it ends; one the email service could not take is tried again, a minute on and doubling
   * to an hour, for a day.
   */
  async run(
    shopId: string,
    id: string,
    at: Date,
    sender: ScheduledExportSender,
  ): Promise<ExportRunOutcome> {
    // Held for a while, so that no other worker sends it too.
    const taken = await this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<ScheduleRow>(sql`
        UPDATE orders.export_schedules
           SET next_run_at = ${new Date(at.getTime() + EXPORT_SCHEDULE_LIMITS.leaseMs).toISOString()},
               attempts = attempts + 1
         WHERE shop_id = ${shopId} AND id = ${id} AND next_run_at <= ${at.toISOString()}
        RETURNING ${COLUMNS}`);
      const row = rows[0];
      if (!row) return null;
      const shop = await shopProfile(tx, shopId);
      const recipient = await recipientIn(tx, shopId, row.user_id);
      const { rows: bounds } = await tx.execute<{
        placed_from: string | Date;
        placed_before: string | Date;
        planned: string | Date;
      }>(sql`
        SELECT (${row.period_end}::date - ${`1 ${UNITS[row.frequency]}`}::interval)
                 AT TIME ZONE ${shop.timezone} AS placed_from,
               ${row.period_end}::date::timestamp AT TIME ZONE ${shop.timezone} AS placed_before,
               (${row.period_end}::date::timestamp + make_interval(hours => ${row.hour}))
                 AT TIME ZONE ${shop.timezone} AS planned`);
      return { row, shop, recipient, bounds: bounds[0]! };
    });
    if (!taken) return 'none';
    const { row, shop, recipient, bounds } = taken;
    const unsent = async (error: string): Promise<ExportRunOutcome> => {
      await this.#next(shopId, row, shop.timezone, { error });
      return 'skipped';
    };
    if (!recipient) {
      return unsent(
        'Not sent: its member of staff no longer works in the shop, or has no proved email',
      );
    }
    if (!EXPORT_ROLES.includes(recipient.role)) {
      return unsent("Not sent: its member of staff's role no longer exports orders");
    }
    const exported = await this.exports.export(
      {
        shopId,
        currency: shop.currency as CurrencyCode,
        scopes: new Set(['read_orders']),
        // As the member of staff it goes to, who sees customers' numbers as their role does.
        actor: {
          kind: 'staff',
          userId: row.user_id,
          sessionId: row.id,
          role: recipient.role,
          authenticatedAt: at,
        },
      },
      {
        layout: row.layout,
        format: row.format,
        query: row.query || null,
        placedFrom: toDate(bounds.placed_from),
        placedBefore: toDate(bounds.placed_before),
        scheduleId: row.id,
      },
    );
    if (!exported.ok) return unsent(`Not sent: ${exported.errors[0]!.message}`);
    const period = exportPeriod(row.frequency, row.period_end);
    const { file, rowCount } = exported.value;
    const outcome = await sender.send(
      scheduledExportEmail({
        to: recipient.email,
        name: recipient.name,
        shop: shop.name,
        frequency: row.frequency,
        layout: row.layout,
        period,
        rows: rowCount,
        file: { ...file, filename: periodFilename(row.frequency, row.layout, period, row.format) },
      }),
    );
    if (outcome === 'sent') {
      await this.#next(shopId, row, shop.timezone, { sentAt: at });
      return 'sent';
    }
    const late = at.getTime() - toDate(bounds.planned).getTime();
    if (outcome === 'retry' && late < EXPORT_SCHEDULE_LIMITS.giveUpMs) {
      const delayMs = Math.min(2 ** Math.max(0, row.attempts - 1), 60) * 60_000;
      await this.db.tenant(shopId, (tx) =>
        tx.execute(sql`
          UPDATE orders.export_schedules
             SET next_run_at = ${new Date(at.getTime() + delayMs).toISOString()},
                 last_error = 'The email could not be sent yet: trying again',
                 updated_at = now()
           WHERE shop_id = ${shopId} AND id = ${id} AND period_end = ${row.period_end}::date`),
      );
      return 'retry';
    }
    return unsent(
      outcome === 'retry'
        ? 'Not sent: the email could not be sent within a day'
        : 'Not sent: the email service refused it',
    );
  }

  /** On to the schedule's next period, due at its hour once that ends. */
  async #next(
    shopId: string,
    row: ScheduleRow,
    timezone: string,
    done: { sentAt: Date } | { error: string },
  ): Promise<void> {
    const step = `1 ${UNITS[row.frequency]}`;
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE orders.export_schedules
           SET period_end = (period_end + ${step}::interval)::date,
               next_run_at = ((period_end + ${step}::interval)::timestamp
                              + make_interval(hours => hour)) AT TIME ZONE ${timezone},
               attempts = 0,
               ${
                 'sentAt' in done
                   ? sql`last_sent_at = ${done.sentAt.toISOString()}, last_error = NULL,`
                   : sql`last_error = ${done.error.slice(0, 1_000)},`
               }
               updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${row.id} AND period_end = ${row.period_end}::date`),
    );
  }
}

/**
 * Whom a member of staff's scheduled export goes to, as identity knows them now (ADR-183): their
 * proved email, while they work in the shop; null otherwise.
 */
async function recipientIn(tx: Tx, shopId: string, userId: string): Promise<Recipient | null> {
  const { rows } = await tx.execute<{ email: string; name: string; role: StaffRole }>(
    sql`SELECT email, name, role FROM identity.staff_email(${userId}, ${shopId})`,
  );
  return rows[0] ?? null;
}

function toRecord(row: ScheduleRow): ExportScheduleRecord {
  return {
    id: row.id,
    userId: row.user_id,
    frequency: row.frequency,
    hour: row.hour,
    layout: row.layout,
    format: row.format,
    query: row.query,
    nextRunAt: toDate(row.next_run_at),
    nextPeriod: exportPeriod(row.frequency, row.period_end),
    lastSentAt: toDateOrNull(row.last_sent_at),
    lastError: row.last_error,
    createdAt: toDate(row.created_at),
  };
}
