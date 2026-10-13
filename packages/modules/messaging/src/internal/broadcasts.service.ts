import {
  InputChecker,
  actorColumnsOf,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SegmentQueryError, SegmentService } from '@hatti/customers/public';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  MessagingEvents,
  type BroadcastChangedPayload,
  type BroadcastSentPayload,
} from './events.js';
import { MessagesService } from './messages.service.js';
import type { MessageLanguage } from './templates.js';
import { WhatsAppTemplatesService } from './whatsapp-templates.service.js';

export const BROADCAST_STATUSES = ['scheduled', 'sending', 'sent', 'cancelled', 'failed'] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

/** How far ahead a broadcast may be set to go. */
export const BROADCAST_AHEAD_DAYS = 30;

/** The customers a round of the worker queues of one broadcast (ADR-422). */
export const BROADCAST_BATCH = 500;

/** What a template's {{1}} says of a customer whose name the shop does not have. */
export const NO_NAME: Record<MessageLanguage, string> = { en: 'there', ur: 'دوست' };

/** What the worker did of a broadcast in a round (ADR-422). */
export type BroadcastRound =
  /** Its messages queued for so many more customers, and whether it has more to queue. */
  | { outcome: 'queued'; queued: number; done: boolean }
  /** Outside the hours marketing may go: it waits until then. */
  | { outcome: 'waiting'; until: Date }
  /** It cannot go: its template or segment is gone, or the shop's number. */
  | { outcome: 'failed'; error: string }
  /** Sent, cancelled or failed already, by another round or the shop. */
  | { outcome: 'none' };

/** The shop as the worker acts for it: only its ID is read. */
export function workerTenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: '00000000-0000-0000-0000-000000000000' },
    scopes: new Set(),
  };
}

/** A customer's first name, as a template's {{1}} greets them. */
export function firstName(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0]?.slice(0, 60) || null;
}

/** Who a broadcast reaches of a segment: those who agreed to hear from the shop on WhatsApp. */
const CONSENTED = 'whatsapp_subscription_status = subscribed';

/** The customers a broadcast reaches, in the segment query language (ADR-024). */
export function audienceQuery(segmentQuery: string | null): string {
  return segmentQuery ? `(${segmentQuery}) AND ${CONSENTED}` : CONSENTED;
}

/** How a broadcast's messages went, by their statuses. */
export interface BroadcastCounts {
  /** Queued and not yet sent: waiting for their turn, or for the shop's credit. */
  pending: number;
  /** Taken by WhatsApp, delivered and read among them. */
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  /** Not sent: the customer had asked the shop to stop, or the broadcast was cancelled. */
  skipped: number;
}

/** A broadcast, as the Admin API shows it (ADR-421). */
export interface BroadcastRecord {
  id: string;
  name: string;
  templateId: string;
  templateName: string;
  templateLanguage: MessageLanguage;
  templateBody: string;
  segmentId: string | null;
  segmentName: string | null;
  sendAt: Date;
  status: BroadcastStatus;
  error: string | null;
  /** The customers queued so far. */
  recipients: number;
  counts: BroadcastCounts;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface BroadcastInput {
  name: string;
  /** One of the shop's approved templates. */
  templateId: string;
  /** None: every customer who agreed to hear from the shop on WhatsApp. */
  segmentId?: string | null;
  /** When it goes; now if not given. */
  sendAt?: Date | null;
}

type BroadcastRow = {
  id: string;
  after_customer: string | null;
  name: string;
  template_id: string;
  template_name: string;
  template_language: MessageLanguage;
  template_body: string;
  segment_id: string | null;
  segment_name: string | null;
  send_at: string | Date;
  status: BroadcastStatus;
  error: string | null;
  recipients: number;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  created_at: string | Date;
};

const COLUMNS = sql`id, after_customer, name, template_id, template_name, template_language, template_body,
                    segment_id, segment_name, send_at, status, error, recipients, started_at,
                    finished_at, created_at`;

const NO_COUNTS: BroadcastCounts = {
  pending: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  skipped: 0,
};

/**
 * A shop's WhatsApp broadcasts (MKT-01, ADR-421): one of its own approved templates (ADR-420) to
 * the customers of a segment who agreed to hear from it on WhatsApp, or to all who did, from its
 * own number (ADR-419), now or at a time up to 30 days ahead. The worker queues them in the hours
 * marketing may go (ADR-422). Until then, and while it queues, a broadcast can be cancelled.
 * Scheduled and cancelled broadcasts are audited, and each is an event.
 */
@Injectable()
export class BroadcastsService {
  constructor(
    private readonly db: Database,
    private readonly templates: WhatsAppTemplatesService,
    private readonly segments: SegmentService,
    private readonly messages: MessagesService,
  ) {}

  /** The broadcasts due at `at`, whichever shop's, the longest due first: the worker's to queue. */
  async due(at: Date, limit = 50): Promise<{ shopId: string; id: string }[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; id: string }>(sql`
        SELECT shop_id, id FROM messaging.broadcasts
         WHERE status IN ('scheduled', 'sending') AND send_at <= ${at.toISOString()}
         ORDER BY send_at, id
         LIMIT ${limit}`),
    );
    return rows.map((row) => ({ shopId: row.shop_id, id: row.id }));
  }

  /**
   * Queues a broadcast's next customers (ADR-422), at most `batch`, from where it got to: in the
   * hours marketing may go, while its template is approved on the shop's number and its segment
   * is there. Each customer's message is queued once, however often a round is repeated.
   */
  async queueNext(
    shopId: string,
    id: string,
    at: Date,
    batch: number = BROADCAST_BATCH,
  ): Promise<BroadcastRound> {
    const row = await this.db.tenant(shopId, (tx) => broadcastIn(tx, shopId, id));
    if (!row || !['scheduled', 'sending'].includes(row.status)) return { outcome: 'none' };
    const hours = await this.messages.marketingHoursOf(shopId, at);
    if (!hours.open) return { outcome: 'waiting', until: hours.nextOpen };

    const tenant = workerTenant(shopId);
    const template = (await this.templates.list(tenant)).find(
      (each) => each.id === row.template_id,
    );
    if (!template) {
      return this.#fail(shopId, id, "Its template is gone from the shop's own WhatsApp number");
    }
    if (template.status !== 'approved') {
      return this.#fail(
        shopId,
        id,
        `Meta no longer approves its template: it is ${template.status}`,
      );
    }
    let query: string | null = null;
    if (row.segment_id) {
      const segment = await this.segments.get(tenant, row.segment_id);
      if (!segment) return this.#fail(shopId, id, 'Its segment was deleted');
      query = segment.query;
    }
    let page;
    try {
      page = await this.segments.members(tenant, audienceQuery(query), {
        first: batch,
        after: row.after_customer,
      });
    } catch (error) {
      if (!(error instanceof SegmentQueryError)) throw error;
      return this.#fail(shopId, id, `Its segment's query no longer works: ${error.message}`);
    }

    const named = template.body.includes('{{1}}');
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<BroadcastRow>(sql`
        SELECT ${COLUMNS} FROM messaging.broadcasts
         WHERE shop_id = ${shopId} AND id = ${id} FOR UPDATE`);
      const current = rows[0];
      // Another round, or the shop, moved it on meanwhile.
      if (
        !current ||
        !['scheduled', 'sending'].includes(current.status) ||
        current.after_customer !== row.after_customer
      ) {
        return { outcome: 'none' } as const;
      }
      const { name: shop } = await shopProfile(tx, shopId);
      let queued = 0;
      for (const customer of page.items) {
        const queuedId = await this.messages.queueIn(tx, shopId, {
          kind: 'broadcast',
          recipient: customer.phone,
          customerId: customer.id,
          variables: {
            shop,
            template: current.template_name,
            ...(named && {
              name: firstName(customer.name) ?? NO_NAME[current.template_language],
            }),
          },
          dedupeKey: `broadcast:${id}:${customer.id}`,
          channel: 'whatsapp',
          language: current.template_language,
          broadcastId: id,
        });
        if (queuedId) queued++;
      }
      const done = !page.hasNextPage;
      const last = page.items.at(-1)?.id ?? current.after_customer;
      await tx.execute(sql`
        UPDATE messaging.broadcasts
           SET recipients = recipients + ${queued}, after_customer = ${last},
               status = ${done ? 'sent' : 'sending'},
               started_at = coalesce(started_at, now()),
               finished_at = ${done ? sql`now()` : sql`NULL`}, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id}`);
      if (done) {
        await appendEvent<BroadcastSentPayload>(tx, shopId, {
          type: MessagingEvents.BroadcastSent,
          aggregateType: 'broadcast',
          aggregateId: id,
          payload: { recipients: current.recipients + queued },
        });
      }
      return { outcome: 'queued', queued, done } as const;
    });
  }

  async #fail(shopId: string, id: string, error: string): Promise<BroadcastRound> {
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE messaging.broadcasts
           SET status = 'failed', error = ${error}, finished_at = now(), updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id} AND status IN ('scheduled', 'sending')`),
    );
    return { outcome: 'failed', error };
  }

  /**
   * How many customers a broadcast to the segment, or to all, would reach now: those who agreed
   * to hear from the shop on WhatsApp.
   */
  async recipientsOf(
    tenant: TenantContext,
    segmentId: string | null,
  ): Promise<MutationResult<number>> {
    let query: string | null = null;
    if (segmentId) {
      const segment = await this.segments.get(tenant, segmentId);
      if (!segment) return failOne(['segmentId'], 'NOT_FOUND', 'No such segment');
      query = segment.query;
    }
    try {
      return { ok: true, value: await this.segments.count(tenant, audienceQuery(query)) };
    } catch (error) {
      if (!(error instanceof SegmentQueryError)) throw error;
      return failOne(
        ['segmentId'],
        'INVALID',
        `The segment's query no longer works: ${error.message}`,
      );
    }
  }

  /** Schedules a broadcast: checked as it will be sent, the template's words kept with it. */
  async create(
    tenant: TenantContext,
    input: BroadcastInput,
    now: Date = new Date(),
  ): Promise<MutationResult<BroadcastRecord>> {
    const check = new InputChecker();
    const name = check.text(['input', 'name'], input.name, { max: 100, required: true });
    const sendAt = input.sendAt ?? now;
    if (sendAt.getTime() < now.getTime() - 60_000) {
      check.add(['input', 'sendAt'], 'INVALID', "can't be in the past");
    } else if (sendAt.getTime() > now.getTime() + BROADCAST_AHEAD_DAYS * 86_400_000) {
      check.add(
        ['input', 'sendAt'],
        'INVALID',
        `can't be more than ${BROADCAST_AHEAD_DAYS} days ahead`,
      );
    }
    if (!check.ok || !name) return { ok: false, errors: check.errors };

    const template = (await this.templates.list(tenant)).find(
      (each) => each.id === input.templateId,
    );
    if (!template) {
      return failOne(['input', 'templateId'], 'NOT_FOUND', "No such template on the shop's number");
    }
    if (template.status !== 'approved') {
      return failOne(['input', 'templateId'], 'INVALID', "Meta hasn't approved this template");
    }
    let segment: { id: string; name: string } | null = null;
    if (input.segmentId) {
      const found = await this.segments.get(tenant, input.segmentId);
      if (!found) return failOne(['input', 'segmentId'], 'NOT_FOUND', 'No such segment');
      segment = { id: found.id, name: found.name };
    }

    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<BroadcastRow>(sql`
        INSERT INTO messaging.broadcasts
               (shop_id, name, template_id, template_name, template_language, template_body,
                segment_id, segment_name, send_at)
        VALUES (${tenant.shopId}, ${name}, ${template.id}, ${template.name}, ${template.language},
                ${template.body}, ${segment?.id ?? null}, ${segment?.name ?? null},
                ${sendAt.toISOString()})
        RETURNING ${COLUMNS}`);
      const row = rows[0]!;
      await this.#changed(tx, tenant, row, MessagingEvents.BroadcastScheduled);
      return { ok: true, value: toRecord(row, NO_COUNTS) };
    });
  }

  /**
   * Cancels a broadcast not yet sent: one being queued stops, and its messages not yet sent are
   * not sent.
   */
  async cancel(tenant: TenantContext, id: string): Promise<MutationResult<BroadcastRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<BroadcastRow>(sql`
        UPDATE messaging.broadcasts
           SET status = 'cancelled', finished_at = now(), updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}
           AND status IN ('scheduled', 'sending')
        RETURNING ${COLUMNS}`);
      const row = rows[0];
      if (!row) {
        const current = await broadcastIn(tx, tenant.shopId, id);
        return current
          ? failOne<BroadcastRecord>(
              ['id'],
              'INVALID',
              `The broadcast is ${current.status} already`,
            )
          : failOne<BroadcastRecord>(['id'], 'NOT_FOUND', 'No such broadcast');
      }
      await tx.execute(sql`
        UPDATE messaging.messages
           SET status = 'skipped', error = 'Not sent: the broadcast was cancelled'
         WHERE shop_id = ${tenant.shopId} AND broadcast_id = ${id} AND status = 'pending'`);
      await this.#changed(tx, tenant, row, MessagingEvents.BroadcastCancelled);
      return {
        ok: true,
        value: toRecord(row, (await countsIn(tx, tenant.shopId, [id])).get(id) ?? NO_COUNTS),
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<BroadcastRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await broadcastIn(tx, tenant.shopId, id);
      if (!row) return null;
      return toRecord(row, (await countsIn(tx, tenant.shopId, [id])).get(id) ?? NO_COUNTS);
    });
  }

  /** The shop's broadcasts, the latest first, a page at a time. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null },
  ): Promise<{ items: BroadcastRecord[]; hasNextPage: boolean }> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<BroadcastRow>(sql`
        SELECT ${COLUMNS} FROM messaging.broadcasts
         WHERE shop_id = ${tenant.shopId}
           ${options.after ? sql`AND id < ${options.after}` : sql``}
         ORDER BY id DESC
         LIMIT ${options.first + 1}`);
      const page = rows.slice(0, options.first);
      const counts = await countsIn(
        tx,
        tenant.shopId,
        page.map((row) => row.id),
      );
      return {
        items: page.map((row) => toRecord(row, counts.get(row.id) ?? NO_COUNTS)),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async #changed(
    tx: Tx,
    tenant: TenantContext,
    row: BroadcastRow,
    type: typeof MessagingEvents.BroadcastScheduled | typeof MessagingEvents.BroadcastCancelled,
  ): Promise<void> {
    const actor = actorColumnsOf(tenant.actor);
    await appendEvent<BroadcastChangedPayload>(tx, tenant.shopId, {
      type,
      aggregateType: 'broadcast',
      aggregateId: row.id,
      payload: { sendAt: toDate(row.send_at).toISOString(), ...actor },
    });
    await recordAudit(tx, tenant.shopId, {
      action: type,
      subjectType: 'broadcast',
      subjectId: row.id,
      ...actor,
      details: {
        name: row.name,
        template: row.template_name,
        language: row.template_language,
        segment: row.segment_name,
        sendAt: toDate(row.send_at).toISOString(),
      },
    });
  }
}

async function broadcastIn(tx: Tx, shopId: string, id: string): Promise<BroadcastRow | null> {
  const { rows } = await tx.execute<BroadcastRow>(sql`
    SELECT ${COLUMNS} FROM messaging.broadcasts WHERE shop_id = ${shopId} AND id = ${id}`);
  return rows[0] ?? null;
}

/** How each broadcast's messages went, by their statuses. */
async function countsIn(
  tx: Tx,
  shopId: string,
  ids: readonly string[],
): Promise<Map<string, BroadcastCounts>> {
  const counts = new Map<string, BroadcastCounts>();
  if (ids.length === 0) return counts;
  const { rows } = await tx.execute<{ broadcast_id: string; status: string; count: number }>(sql`
    SELECT broadcast_id, status, count(*)::int AS count
      FROM messaging.messages
     WHERE shop_id = ${shopId} AND broadcast_id = ANY (${sql.param([...ids])}::uuid[])
     GROUP BY broadcast_id, status`);
  for (const row of rows) {
    const each = counts.get(row.broadcast_id) ?? { ...NO_COUNTS };
    if (row.status === 'pending') each.pending += row.count;
    if (row.status === 'failed') each.failed += row.count;
    if (row.status === 'skipped') each.skipped += row.count;
    if (['sent', 'delivered', 'read'].includes(row.status)) each.sent += row.count;
    if (['delivered', 'read'].includes(row.status)) each.delivered += row.count;
    if (row.status === 'read') each.read += row.count;
    counts.set(row.broadcast_id, each);
  }
  return counts;
}

function toRecord(row: BroadcastRow, counts: BroadcastCounts): BroadcastRecord {
  return {
    id: row.id,
    name: row.name,
    templateId: row.template_id,
    templateName: row.template_name,
    templateLanguage: row.template_language,
    templateBody: row.template_body,
    segmentId: row.segment_id,
    segmentName: row.segment_name,
    sendAt: toDate(row.send_at),
    status: row.status,
    error: row.error,
    recipients: row.recipients,
    counts,
    startedAt: toDateOrNull(row.started_at),
    finishedAt: toDateOrNull(row.finished_at),
    createdAt: toDate(row.created_at),
  };
}
