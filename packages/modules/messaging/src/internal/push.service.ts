import {
  failOne,
  scopeWithin,
  type AccessScope,
  type MutationResult,
  type StaffCapability,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate } from '@hatti/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { WebPushSender, type PushOutcome } from './web-push.js';

// Push notifications for staff (APP-03, ADR-506): each browser a member of staff turns them on in
// subscribes with its push service, for the kinds of news they chose; the worker pushes each to
// the staff whose role does the work it is about, and who may do it (ADR-581), in their own
// language, once.

export const PUSH_KINDS = [
  'new_order',
  'needs_review',
  'cash_remitted',
  'low_stock',
  // A shopper wrote through the contact form (ADR-591).
  'contact_message',
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/** Whose work each kind of news is: the roles told of it. */
export const PUSH_ROLES: Record<PushKind, readonly StaffRole[]> = {
  new_order: ['owner', 'manager', 'confirmation_agent'],
  needs_review: ['owner', 'manager', 'confirmation_agent'],
  cash_remitted: ['owner', 'manager', 'accountant'],
  low_stock: ['owner', 'manager'],
  contact_message: ['owner', 'manager', 'confirmation_agent'],
};

/**
 * What each kind of news needs of those its roles are told of (ADR-581): the work it calls them
 * to, which every member of those roles' presets may do, and a custom role's only if it holds it.
 */
export const PUSH_NEEDS: Record<PushKind, AccessScope | StaffCapability> = {
  new_order: 'write_orders',
  needs_review: 'write_orders',
  cash_remitted: 'reconcile_payments',
  low_stock: 'write_inventory',
  contact_message: 'write_conversations',
};

/** Whether `recipient` is told of news of `kind`: their role's work, which they may do. */
export function pushedTo(kind: PushKind, recipient: PushRecipient): boolean {
  if (!PUSH_ROLES[kind].includes(recipient.role)) return false;
  const needs = PUSH_NEEDS[kind];
  return needs.startsWith('read_') || needs.startsWith('write_')
    ? scopeWithin(needs as AccessScope, recipient.scopes)
    : recipient.capabilities.has(needs as StaffCapability);
}

export const PUSH_LIMITS = {
  /** Pushes in a row that may fail before a subscription is given up. */
  failures: 20,
  /** Pushes sent at once. */
  concurrency: 8,
} as const;

/** The sender, where Hatti has VAPID keys; null where it has none, and pushes are off. */
export const PUSH_SENDER = Symbol('PUSH_SENDER');

export interface PushSubscriptionRecord {
  endpoint: string;
  kinds: PushKind[];
  createdAt: Date;
}

/** What is pushed: words in English and in Urdu, and the admin's page it opens. */
export interface PushMessage {
  en: { title: string; body: string };
  ur: { title: string; body: string };
  /** The admin's path, from its root: "/shop_x/orders/order_y". */
  url: string;
}

/** A member of staff to tell, in their language, with what they may do in the shop (ADR-581). */
export interface PushRecipient {
  userId: string;
  role: StaffRole;
  language: 'en' | 'ur';
  scopes: readonly AccessScope[];
  capabilities: ReadonlySet<StaffCapability>;
}

const ENDPOINT = /^https:\/\/[^\s]{1,990}$/;
const KEY = /^[A-Za-z0-9_-]{86,88}$/;
const SECRET = /^[A-Za-z0-9_-]{16,24}$/;

@Injectable()
export class PushService {
  constructor(
    private readonly db: Database,
    @Optional() @Inject(PUSH_SENDER) private readonly sender: WebPushSender | null = null,
  ) {}

  /** The key browsers subscribe with; null where pushes are off. */
  get publicKey(): string | null {
    return this.sender?.publicKey ?? null;
  }

  /**
   * Turns pushes on in a browser of the signed-in member of staff, for the kinds given, or
   * changes the kinds: the browser's subscription, its endpoint and keys as it gave them. A
   * browser another member of staff signed in on is theirs now.
   */
  async subscribe(
    tenant: TenantContext,
    input: { endpoint: string; p256dh: string; auth: string; kinds: readonly string[] },
  ): Promise<MutationResult<PushSubscriptionRecord>> {
    if (tenant.actor.kind !== 'staff') {
      return failOne(['input'], 'INVALID', "Pushes go to staff's phones, not to apps");
    }
    if (!this.sender) {
      return failOne(['input'], 'INVALID', 'Push notifications are not turned on for Hatti yet');
    }
    if (!ENDPOINT.test(input.endpoint)) {
      return failOne(['input', 'endpoint'], 'INVALID', "must be the push service's https address");
    }
    if (!KEY.test(input.p256dh) || !SECRET.test(input.auth)) {
      return failOne(['input', 'p256dh'], 'INVALID', "must be the browser's key and secret");
    }
    const kinds = [...new Set(input.kinds)];
    const unknown = kinds.find((kind) => !(PUSH_KINDS as readonly string[]).includes(kind));
    if (unknown !== undefined) {
      return failOne(['input', 'kinds'], 'INVALID', `${unknown} is not news Hatti pushes`);
    }
    const userId = tenant.actor.userId;
    const row = await this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        endpoint: string;
        kinds: PushKind[];
        created_at: string;
      }>(
        sql`
        INSERT INTO messaging.push_subscriptions (shop_id, user_id, endpoint, p256dh, auth, kinds)
             VALUES (${tenant.shopId}, ${userId}, ${input.endpoint}, ${input.p256dh}, ${input.auth},
                     ${sql.param(kinds)}::text[])
        ON CONFLICT (shop_id, endpoint) DO UPDATE
              SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                  kinds = EXCLUDED.kinds, failures = 0, updated_at = now()
        RETURNING endpoint, kinds, created_at`,
      );
      return rows[0]!;
    });
    return {
      ok: true,
      value: { endpoint: row.endpoint, kinds: row.kinds, createdAt: toDate(row.created_at) },
    };
  }

  /** Turns pushes off in the signed-in member of staff's browser. Whether they were on. */
  async unsubscribe(tenant: TenantContext, endpoint: string): Promise<boolean> {
    if (tenant.actor.kind !== 'staff') return false;
    const userId = tenant.actor.userId;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute(sql`
        DELETE FROM messaging.push_subscriptions
         WHERE shop_id = ${tenant.shopId} AND endpoint = ${endpoint} AND user_id = ${userId}
        RETURNING id`);
      return rows.length > 0;
    });
  }

  /** The signed-in member of staff's subscription of the browser at `endpoint`, if any. */
  async subscriptionOf(
    tenant: TenantContext,
    endpoint: string,
  ): Promise<PushSubscriptionRecord | null> {
    if (tenant.actor.kind !== 'staff') return null;
    const userId = tenant.actor.userId;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        endpoint: string;
        kinds: PushKind[];
        created_at: string;
      }>(
        sql`
        SELECT endpoint, kinds, created_at FROM messaging.push_subscriptions
         WHERE shop_id = ${tenant.shopId} AND endpoint = ${endpoint} AND user_id = ${userId}`,
      );
      const row = rows[0];
      return row
        ? { endpoint: row.endpoint, kinds: row.kinds, createdAt: toDate(row.created_at) }
        : null;
    });
  }

  /**
   * Pushes `message`, of `kind`, to the browsers of those of `recipients` whose role does that
   * work, who may do it ({@link pushedTo}) and who chose it, each in their language; once for `dedupeKey`, however often asked.
   * Forgets subscriptions their push service says are gone, and those that failed too often.
   * How many browsers it went to.
   */
  async push(
    shopId: string,
    kind: PushKind,
    dedupeKey: string,
    recipients: readonly PushRecipient[],
    message: PushMessage,
  ): Promise<number> {
    if (!this.sender) return 0;
    const sender = this.sender;
    const told = recipients.filter((each) => pushedTo(kind, each));
    if (told.length === 0) return 0;
    const language = new Map(told.map((each) => [each.userId, each.language]));
    const subscriptions = await this.db.tenant(shopId, async (tx) => {
      const { rows: first } = await tx.execute(sql`
        INSERT INTO messaging.push_deliveries (shop_id, dedupe_key)
             VALUES (${shopId}, ${dedupeKey.slice(0, 200)})
        ON CONFLICT DO NOTHING RETURNING dedupe_key`);
      if (first.length === 0) return [];
      const { rows } = await tx.execute<{
        id: string;
        user_id: string;
        endpoint: string;
        p256dh: string;
        auth: string;
      }>(sql`
        SELECT id, user_id, endpoint, p256dh, auth FROM messaging.push_subscriptions
         WHERE shop_id = ${shopId} AND ${kind} = ANY (kinds)
           AND user_id = ANY (${sql.param([...language.keys()])}::uuid[])`);
      return rows;
    });
    if (subscriptions.length === 0) return 0;

    const outcomes: { id: string; outcome: PushOutcome }[] = [];
    for (let start = 0; start < subscriptions.length; start += PUSH_LIMITS.concurrency) {
      const batch = subscriptions.slice(start, start + PUSH_LIMITS.concurrency);
      outcomes.push(
        ...(await Promise.all(
          batch.map(async (each) => {
            const words = message[language.get(each.user_id) ?? 'en'];
            const outcome = await sender.send(
              { endpoint: each.endpoint, p256dh: each.p256dh, auth: each.auth },
              { ...words, url: message.url, tag: dedupeKey.slice(0, 64) },
              { urgency: kind === 'low_stock' || kind === 'contact_message' ? 'normal' : 'high' },
            );
            return { id: each.id, outcome };
          }),
        )),
      );
    }
    const ids = (wanted: PushOutcome) =>
      outcomes.filter((each) => each.outcome === wanted).map((each) => each.id);
    await this.db.tenant(shopId, async (tx) => {
      const sent = ids('sent');
      const gone = ids('gone');
      const failed = ids('failed');
      if (sent.length > 0) {
        await tx.execute(sql`
          UPDATE messaging.push_subscriptions SET last_sent_at = now(), failures = 0
           WHERE shop_id = ${shopId} AND id = ANY (${sql.param(sent)}::uuid[])`);
      }
      if (failed.length > 0) {
        await tx.execute(sql`
          UPDATE messaging.push_subscriptions SET failures = failures + 1
           WHERE shop_id = ${shopId} AND id = ANY (${sql.param(failed)}::uuid[])`);
      }
      await tx.execute(sql`
        DELETE FROM messaging.push_subscriptions
         WHERE shop_id = ${shopId}
           AND (id = ANY (${sql.param(gone)}::uuid[]) OR failures >= ${PUSH_LIMITS.failures})`);
    });
    return ids('sent').length;
  }
}
