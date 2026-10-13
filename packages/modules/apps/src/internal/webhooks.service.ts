import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit, type DomainEvent } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { sealedFor } from './apps.js';
import { WebhookEvents, type WebhookSubscriptionChangedPayload } from './events.js';
import type { WebhookSender } from './webhook-sender.js';
import {
  WEBHOOK_LIMITS,
  isWebhookTopic,
  retryDelayMs,
  scopesFor,
  signWebhook,
  topicsOf,
  uriProblem,
  webhookBody,
  type WebhookTopic,
} from './webhooks.js';

/** One of an app's subscriptions, as the Admin API shows it. */
export interface WebhookSubscriptionRecord {
  id: string;
  appId: string;
  appName: string;
  topic: WebhookTopic;
  uri: string;
  createdAt: Date;
  updatedAt: Date;
  /** Its latest delivery, if it has had one. */
  lastDelivery: WebhookDeliveryRecord | null;
}

/** One of a subscription's deliveries: how its tries went. */
export interface WebhookDeliveryRecord {
  id: string;
  /** "pending" until delivered, or given up on as "failed". */
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  /** The app's HTTP status at the last try, if it answered. */
  responseStatus: number | null;
  error: string | null;
  createdAt: Date;
  lastAttemptAt: Date | null;
  /** When it is tried next, while pending. */
  nextAttemptAt: Date | null;
}

type DeliveryRow = {
  id: string;
  status: WebhookDeliveryRecord['status'];
  attempts: number;
  response_status: number | null;
  error: string | null;
  created_at: string | Date;
  last_attempt_at: string | Date | null;
  next_attempt_at: string | Date;
};

function toDelivery(row: DeliveryRow): WebhookDeliveryRecord {
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    responseStatus: row.response_status,
    error: row.error,
    createdAt: toDate(row.created_at),
    lastAttemptAt: row.last_attempt_at === null ? null : toDate(row.last_attempt_at),
    nextAttemptAt: row.status === 'pending' ? toDate(row.next_attempt_at) : null,
  };
}

/** What a sweep did. */
export interface WebhookSweep {
  delivered: number;
  /** Tried and to be tried again. */
  retrying: number;
  /** Given up on. */
  failed: number;
}

type SubscriptionRow = {
  id: string;
  app_id: string;
  app_name: string;
  topic: string;
  uri: string;
  created_at: string | Date;
  updated_at: string | Date;
  last_delivery: DeliveryRow | null;
};

function toRecord(row: SubscriptionRow): WebhookSubscriptionRecord {
  return {
    id: row.id,
    appId: row.app_id,
    appName: row.app_name,
    topic: row.topic as WebhookTopic,
    uri: row.uri,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    lastDelivery: row.last_delivery && toDelivery(row.last_delivery),
  };
}

const DELIVERY_COLUMNS = sql.raw(
  'd.id, d.status, d.attempts, d.response_status, d.error, d.created_at, d.last_attempt_at, ' +
    'd.next_attempt_at',
);

async function subscriptionsIn(
  tx: Tx,
  shopId: string,
  where: { id?: string; appId?: string | null },
): Promise<SubscriptionRow[]> {
  const { rows } = await tx.execute<SubscriptionRow>(sql`
    SELECT s.id, s.app_id, t.name AS app_name, s.topic, s.uri, s.created_at, s.updated_at,
           (SELECT row_to_json(last) FROM (
              SELECT ${DELIVERY_COLUMNS} FROM apps.webhook_deliveries d
               WHERE d.shop_id = s.shop_id AND d.subscription_id = s.id
               ORDER BY d.created_at DESC, d.id DESC LIMIT 1) last) AS last_delivery
      FROM apps.webhook_subscriptions s
      JOIN apps.access_tokens t ON t.shop_id = s.shop_id AND t.id = s.app_id
     WHERE s.shop_id = ${shopId} AND t.revoked_at IS NULL
       ${where.id ? sql`AND s.id = ${where.id}` : sql``}
       ${where.appId ? sql`AND s.app_id = ${where.appId}` : sql``}
     ORDER BY t.name, s.topic, s.created_at`);
  return rows;
}

const NOT_FOUND = 'No webhook subscription of the shop has this ID';

/** A delivery claimed for a try, with where it goes and what signs it. */
type DueRow = {
  shop_id: string;
  id: string;
  event_id: string;
  topic: string;
  body: unknown;
  attempts: number;
  created_at: string | Date;
  uri: string;
  app_id: string;
  webhook_secret: string | null;
  revoked: boolean;
};

/**
 * Webhooks (DEV-03, ADR-397): an app's subscriptions to topics of the shop's events, each at an
 * https address, made by the app itself or by the shop's owner or a manager for it; and their
 * deliveries. Each event the worker hears becomes one delivery for each subscription to a topic it
 * makes, whose app may read what it names; the sweep posts those due, signed with the app's
 * secret, and tries a failed one again later, for two days. Outcomes are kept for 30 days.
 */
@Injectable()
export class WebhookService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  /** The shop's subscriptions, or one app's, by app and topic. */
  async list(tenant: TenantContext, appId: string | null): Promise<WebhookSubscriptionRecord[]> {
    const rows = await this.db.tenant(tenant.shopId, (tx) =>
      subscriptionsIn(tx, tenant.shopId, { appId }),
    );
    return rows.map(toRecord);
  }

  /** Subscribes an app to a topic at an address, if it may read what the topic names. */
  async create(
    tenant: TenantContext,
    appId: string,
    input: { topic: string; uri: string },
  ): Promise<MutationResult<WebhookSubscriptionRecord>> {
    const check = new InputChecker();
    if (!isWebhookTopic(input.topic)) check.add(['topic'], 'INVALID', 'is not a topic');
    const uri = this.#uri(check, input.uri);
    if (!check.ok) return { ok: false, errors: check.errors };
    const topic = input.topic as WebhookTopic;

    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: apps } = await tx.execute<{ scopes: string[] }>(sql`
        SELECT scopes FROM apps.access_tokens
         WHERE shop_id = ${tenant.shopId} AND id = ${appId} AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())`);
      const app = apps[0];
      if (!app) return failOne(['appId'], 'NOT_FOUND', 'No app of the shop has this ID');
      const needs = scopesFor(topic);
      if (needs.length > 0 && !needs.some((scope) => app.scopes.includes(scope))) {
        return failOne(
          ['topic'],
          'INVALID',
          `The app can't read what it tells of: give it the ${needs[0]} scope first`,
        );
      }
      const { rows: counted } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM apps.webhook_subscriptions
         WHERE shop_id = ${tenant.shopId} AND app_id = ${appId}`);
      if (counted[0]!.count >= WEBHOOK_LIMITS.subscriptions) {
        return failOne(
          ['topic'],
          'TOO_MANY',
          `An app keeps up to ${WEBHOOK_LIMITS.subscriptions} webhook subscriptions`,
        );
      }
      const id = newId();
      const { rows: inserted } = await tx.execute<{ id: string }>(sql`
        INSERT INTO apps.webhook_subscriptions (shop_id, id, app_id, topic, uri)
        VALUES (${tenant.shopId}, ${id}, ${appId}, ${topic}, ${uri!})
        ON CONFLICT (shop_id, app_id, topic, uri) DO NOTHING
        RETURNING id`);
      if (inserted.length === 0) {
        return failOne(
          ['webhookSubscription', 'callbackUrl'],
          'TAKEN',
          'The app is already sent this topic at this address',
        );
      }
      const [row] = await subscriptionsIn(tx, tenant.shopId, { id });
      const record = toRecord(row!);
      await this.#record(tx, tenant, WebhookEvents.SubscriptionCreated, record);
      return { ok: true, value: record };
    });
  }

  /** Sends a subscription's topic to another address, from its next delivery on. */
  async update(
    tenant: TenantContext,
    id: string,
    appId: string | null,
    input: { uri: string },
  ): Promise<MutationResult<WebhookSubscriptionRecord>> {
    const check = new InputChecker();
    const uri = this.#uri(check, input.uri);
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [current] = await subscriptionsIn(tx, tenant.shopId, { id, appId });
      if (!current) return failOne(['id'], 'NOT_FOUND', NOT_FOUND);
      if (current.uri === uri) return { ok: true, value: toRecord(current) };
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE apps.webhook_subscriptions SET uri = ${uri!}, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}
           AND NOT EXISTS (
             SELECT 1 FROM apps.webhook_subscriptions o
              WHERE o.shop_id = ${tenant.shopId} AND o.app_id = ${current.app_id}
                AND o.topic = ${current.topic} AND o.uri = ${uri!})
        RETURNING id`);
      if (rows.length === 0) {
        return failOne(
          ['webhookSubscription', 'callbackUrl'],
          'TAKEN',
          'The app is already sent this topic at this address',
        );
      }
      const [row] = await subscriptionsIn(tx, tenant.shopId, { id });
      const record = toRecord(row!);
      await this.#record(tx, tenant, WebhookEvents.SubscriptionUpdated, record);
      return { ok: true, value: record };
    });
  }

  /** Ends a subscription: deliveries not yet made are not. */
  async delete(
    tenant: TenantContext,
    id: string,
    appId: string | null,
  ): Promise<MutationResult<WebhookSubscriptionRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [current] = await subscriptionsIn(tx, tenant.shopId, { id, appId });
      if (!current) return failOne(['id'], 'NOT_FOUND', NOT_FOUND);
      await tx.execute(sql`
        DELETE FROM apps.webhook_subscriptions WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      const record = toRecord(current);
      await this.#record(tx, tenant, WebhookEvents.SubscriptionDeleted, record);
      return { ok: true, value: record };
    });
  }

  /**
   * A subscription's deliveries, the latest first, `first` of them; null for a subscription the
   * caller cannot see.
   */
  async deliveries(
    tenant: TenantContext,
    id: string,
    appId: string | null,
    first = 20,
  ): Promise<WebhookDeliveryRecord[] | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [subscription] = await subscriptionsIn(tx, tenant.shopId, { id, appId });
      if (!subscription) return null;
      const { rows } = await tx.execute<DeliveryRow>(sql`
        SELECT ${DELIVERY_COLUMNS} FROM apps.webhook_deliveries d
         WHERE d.shop_id = ${tenant.shopId} AND d.subscription_id = ${id}
         ORDER BY d.created_at DESC, d.id DESC
         LIMIT ${Math.min(Math.max(first, 1), 100)}`);
      return rows.map(toDelivery);
    });
  }

  /**
   * Makes a delivery of `event` for each subscription to a topic it makes, once however often it
   * comes: those of apps that may read what it names, and for an app removed, its own
   * subscriptions to `app/uninstalled` alone. How many it made.
   */
  async fanOut(event: DomainEvent): Promise<number> {
    let made = 0;
    for (const topic of topicsOf(event.type)) {
      const body = webhookBody(topic, event);
      if (!body) continue;
      const needs = scopesFor(topic);
      const own = topic === 'app/uninstalled';
      const { rows } = await this.db.tenant(event.shopId, (tx) =>
        tx.execute<{ id: string }>(sql`
          INSERT INTO apps.webhook_deliveries (shop_id, subscription_id, event_id, topic, body)
          SELECT s.shop_id, s.id, ${event.id}, s.topic, ${JSON.stringify(body)}::jsonb
            FROM apps.webhook_subscriptions s
            JOIN apps.access_tokens t ON t.shop_id = s.shop_id AND t.id = s.app_id
           WHERE s.shop_id = ${event.shopId} AND s.topic = ${topic}
             ${
               own
                 ? sql`AND s.app_id = ${event.aggregateId}`
                 : sql`AND t.revoked_at IS NULL
                       AND (t.expires_at IS NULL OR t.expires_at > now())
                       AND t.scopes && ${sql.param(needs)}::text[]`
             }
          ON CONFLICT (shop_id, subscription_id, event_id) DO NOTHING
          RETURNING id`),
      );
      made += rows.length;
    }
    return made;
  }

  /**
   * Posts the deliveries due at `at`, across shops, up to {@link WEBHOOK_LIMITS.batch}: each
   * claimed for a while first, so two sweeps never post the same one. A failed one is tried again
   * after {@link retryDelayMs}, until two days have passed since it was made; one whose app was
   * removed, or has no secret to sign with, is given up on at once. Outcomes older than 30 days
   * are forgotten.
   */
  async deliverDue(sender: WebhookSender, at: Date = new Date()): Promise<WebhookSweep> {
    const sweep: WebhookSweep = { delivered: 0, retrying: 0, failed: 0 };
    const due = await this.db.system(async (tx) => {
      await tx.execute(sql`
        DELETE FROM apps.webhook_deliveries
         WHERE created_at < ${new Date(at.getTime() - WEBHOOK_LIMITS.keptDays * 86_400_000)}`);
      const { rows } = await tx.execute<DueRow>(sql`
        WITH due AS (
          SELECT shop_id, id FROM apps.webhook_deliveries
           WHERE status = 'pending' AND next_attempt_at <= ${at}
           ORDER BY next_attempt_at
           LIMIT ${WEBHOOK_LIMITS.batch}
             FOR UPDATE SKIP LOCKED
        )
        UPDATE apps.webhook_deliveries d
           SET attempts = d.attempts + 1, last_attempt_at = ${at},
               next_attempt_at = ${new Date(at.getTime() + 5 * 60_000)}
          FROM due, apps.webhook_subscriptions s, apps.access_tokens t
         WHERE d.shop_id = due.shop_id AND d.id = due.id
           AND s.shop_id = d.shop_id AND s.id = d.subscription_id
           AND t.shop_id = s.shop_id AND t.id = s.app_id
        RETURNING d.shop_id, d.id, d.event_id, d.topic, d.body, d.attempts, d.created_at,
                  s.uri, s.app_id, t.webhook_secret, t.revoked_at IS NOT NULL AS revoked`);
      return rows;
    });

    for (const row of due) {
      const outcome = await this.#try(sender, row, at);
      const givenUp =
        outcome.error !== null &&
        (outcome.final ||
          at.getTime() - toDate(row.created_at).getTime() >= WEBHOOK_LIMITS.triesForMs);
      const status = outcome.error === null ? 'delivered' : givenUp ? 'failed' : 'pending';
      await this.db.system((tx) =>
        tx.execute(sql`
          UPDATE apps.webhook_deliveries
             SET status = ${status}, response_status = ${outcome.status},
                 error = ${outcome.error?.slice(0, 500) ?? null},
                 next_attempt_at = ${new Date(at.getTime() + retryDelayMs(row.attempts))}
           WHERE shop_id = ${row.shop_id} AND id = ${row.id}`),
      );
      if (status === 'delivered') sweep.delivered += 1;
      else if (status === 'failed') sweep.failed += 1;
      else sweep.retrying += 1;
    }
    return sweep;
  }

  /** One try of a delivery; `final` when trying again cannot help. */
  async #try(
    sender: WebhookSender,
    row: DueRow,
    at: Date,
  ): Promise<{ status: number | null; error: string | null; final: boolean }> {
    if (row.revoked && row.topic !== 'app/uninstalled') {
      return { status: null, error: 'The app was removed', final: true };
    }
    if (!row.webhook_secret) {
      return { status: null, error: 'The app has no signing secret', final: true };
    }
    const secret = this.box
      .decrypt(row.webhook_secret, sealedFor(row.shop_id, row.app_id))
      .toString('utf8');
    const body = JSON.stringify(row.body);
    const outcome = await sender.send({
      url: row.uri,
      body,
      headers: {
        'x-hatti-topic': row.topic,
        'x-hatti-shop-id': toPublicId('shop', row.shop_id),
        'x-hatti-event-id': toPublicId('event', row.event_id),
        'x-hatti-webhook-id': toPublicId('webhookDelivery', row.id),
        'x-hatti-triggered-at': at.toISOString(),
        'x-hatti-hmac-sha256': signWebhook(secret, body),
      },
    });
    return { ...outcome, final: false };
  }

  #uri(check: InputChecker, value: string): string | null {
    const field = ['webhookSubscription', 'callbackUrl'];
    const uri = check.text(field, value, { required: true, max: WEBHOOK_LIMITS.uri });
    if (uri === null) return null;
    const problem = uriProblem(uri);
    if (problem) check.add(field, 'INVALID', problem);
    return uri;
  }

  async #record(
    tx: Tx,
    tenant: TenantContext,
    type: (typeof WebhookEvents)[keyof typeof WebhookEvents],
    record: WebhookSubscriptionRecord,
  ): Promise<void> {
    const payload = { appId: record.appId, topic: record.topic, uri: record.uri };
    await appendEvent<WebhookSubscriptionChangedPayload>(tx, tenant.shopId, {
      type,
      aggregateType: 'webhook_subscription',
      aggregateId: record.id,
      payload,
    });
    await recordAudit(tx, tenant.shopId, {
      action: type,
      subjectType: 'webhookSubscription',
      subjectId: record.id,
      ...actorColumnsOf(tenant.actor),
      details: payload,
    });
  }
}
