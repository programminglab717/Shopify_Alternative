import {
  InputChecker,
  actorColumnsOf,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { pushSubscriptionsPath, type PushSubscribeErrorResponse } from '@hatti/storefront-api';
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { marketingHours } from './marketing-hours.js';
import { PUSH_SENDER } from './push.service.js';
import { WebPushSender, type PushOutcome } from './web-push.js';

// Pushes to shoppers (OS-14): shoppers turn on notifications from a shop's online store
// (ADR-833), and the shop sends them push campaigns, its words and a page of its own, which the
// worker pushes to every subscribed browser in marketing hours (ADR-834). Hatti's VAPID keys sign
// them, as staff's pushes are signed (ADR-506); without them, pushes are off.

export const SHOPPER_PUSH_LIMITS = {
  title: 60,
  body: 180,
  path: 500,
  /** Campaigns a shop may send in a day of its own time zone. */
  perDay: 3,
  /** Browsers pushed to a round, each round in its own transaction. */
  batch: 500,
  /** Pushes sent at once. */
  concurrency: 16,
  /** Pushes in a row that may fail before a subscription is given up. */
  failures: 5,
} as const;

/**
 * The push services browsers subscribe with: Google's, for Chrome, Edge on Android, Samsung
 * Internet, Opera and Brave; Mozilla's; Apple's; and Microsoft's, for Edge on Windows. A
 * subscription comes from an anonymous browser, so the worker posts to these alone, never to an
 * address a stranger gave it.
 */
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

/** Whether `endpoint` is a push service's https address, on its standard port. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  if (endpoint.length > 1000) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    PUSH_SERVICE_HOSTS.some((host) => host.test(url.hostname))
  );
}

const KEY = /^[A-Za-z0-9_-]{86,88}$/;
const SECRET = /^[A-Za-z0-9_-]{16,24}$/;
/** A path on the shop: from its root, never to another host. */
const SHOP_PATH = /^\/([^/\s]|$)\S*$/;

export interface PushCampaignRecord {
  id: string;
  title: string;
  body: string;
  path: string;
  status: 'sending' | 'sent';
  sent: number;
  failed: number;
  gone: number;
  createdAt: Date;
  sentAt: Date | null;
}

export interface PushCampaignInput {
  title?: string | null;
  body?: string | null;
  /** The shop's page it opens: "/collections/eid"; its home page if left out. */
  path?: string | null;
}

/** What a round of a campaign did. */
export type PushCampaignRound =
  | { outcome: 'none' }
  | { outcome: 'waiting'; until: Date }
  | { outcome: 'pushed'; sent: number; done: boolean };

type CampaignRow = {
  id: string;
  title: string;
  body: string;
  path: string;
  status: 'sending' | 'sent';
  cursor_id: string | null;
  sent: number;
  failed: number;
  gone: number;
  created_at: string;
  sent_at: string | null;
};

const toCampaign = (row: CampaignRow): PushCampaignRecord => ({
  id: row.id,
  title: row.title,
  body: row.body,
  path: row.path,
  status: row.status,
  sent: row.sent,
  failed: row.failed,
  gone: row.gone,
  createdAt: toDate(row.created_at),
  sentAt: row.sent_at === null ? null : toDate(row.sent_at),
});

@Injectable()
export class ShopperPushService {
  constructor(
    private readonly db: Database,
    @Optional() @Inject(PUSH_SENDER) private readonly sender: WebPushSender | null = null,
  ) {}

  /** Whether Hatti has VAPID keys, and so pushes to shoppers at all. */
  get on(): boolean {
    return this.sender !== null;
  }

  /**
   * Keeps a shopper's browser's subscription for the shop, as the storefront passes it on
   * (ADR-833): again, its keys and language change. Null while pushes are off.
   */
  async subscribe(
    shopId: string,
    input: { endpoint?: string; p256dh?: string; auth?: string; locale?: string },
  ): Promise<MutationResult<null> | null> {
    if (!this.sender) return null;
    const check = new InputChecker();
    const endpoint = input.endpoint ?? '';
    if (!isPushServiceEndpoint(endpoint)) {
      check.addMessage(['endpoint'], 'INVALID', "The browser's push service isn't one Hatti knows");
    }
    if (!KEY.test(input.p256dh ?? '') || !SECRET.test(input.auth ?? '')) {
      check.addMessage(['keys'], 'INVALID', "The browser's key and secret are missing");
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    const locale = input.locale === 'ur' ? 'ur' : 'en';
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO messaging.shopper_push_subscriptions (shop_id, endpoint, p256dh, auth, locale)
             VALUES (${shopId}, ${endpoint}, ${input.p256dh!}, ${input.auth!}, ${locale})
        ON CONFLICT (shop_id, endpoint) DO UPDATE
              SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, locale = EXCLUDED.locale,
                  failures = 0, updated_at = now()`),
    );
    return { ok: true, value: null };
  }

  /** Forgets a shopper's browser's subscription. Whether it was kept. */
  async unsubscribe(shopId: string, endpoint: string): Promise<boolean> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute(sql`
        DELETE FROM messaging.shopper_push_subscriptions
         WHERE shop_id = ${shopId} AND endpoint = ${endpoint}
        RETURNING id`);
      return rows.length > 0;
    });
  }

  /** How many browsers have notifications on for the shop. */
  async subscriberCount(tenant: TenantContext): Promise<number> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM messaging.shopper_push_subscriptions
         WHERE shop_id = ${tenant.shopId}`);
      return rows[0]!.count;
    });
  }

  /** The shop's campaigns, the latest first. */
  async campaigns(tenant: TenantContext, first = 20): Promise<PushCampaignRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<CampaignRow>(sql`
        SELECT id, title, body, path, status, cursor_id, sent, failed, gone, created_at, sent_at
          FROM messaging.push_campaigns
         WHERE shop_id = ${tenant.shopId}
         ORDER BY created_at DESC, id DESC
         LIMIT ${Math.min(Math.max(first, 1), 100)}`);
      return rows.map(toCampaign);
    });
  }

  /**
   * Sends a push campaign to every browser with notifications on (ADR-834): its title, its words
   * and the shop's page it opens. The worker pushes it in marketing hours. At most
   * {@link SHOPPER_PUSH_LIMITS.perDay} a day, so that shoppers keep them on.
   */
  async send(
    tenant: TenantContext,
    input: PushCampaignInput,
  ): Promise<MutationResult<PushCampaignRecord>> {
    if (!this.sender) {
      return failOne(['input'], 'INVALID', 'Push notifications are not turned on for Hatti yet');
    }
    const check = new InputChecker();
    const title = check.text(['input', 'title'], input.title, {
      required: true,
      max: SHOPPER_PUSH_LIMITS.title,
    });
    const body = check.text(['input', 'body'], input.body, {
      required: true,
      max: SHOPPER_PUSH_LIMITS.body,
    });
    const path =
      check.text(['input', 'path'], input.path, { max: SHOPPER_PUSH_LIMITS.path }) ?? '/';
    if (!SHOP_PATH.test(path)) {
      check.add(['input', 'path'], 'INVALID', 'must be a page of the shop, like /collections/eid');
    }
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      // One at a time for the shop, so that two at once can't pass the day's limit.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('push_campaigns'), hashtext(${tenant.shopId}))`,
      );
      const { timezone } = await shopProfile(tx, tenant.shopId);
      const { rows: today } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM messaging.push_campaigns
         WHERE shop_id = ${tenant.shopId}
           AND (created_at AT TIME ZONE ${timezone})::date = (now() AT TIME ZONE ${timezone})::date`);
      if (today[0]!.count >= SHOPPER_PUSH_LIMITS.perDay) {
        return failOne(
          ['input'],
          'TOO_MANY',
          `A shop sends at most ${SHOPPER_PUSH_LIMITS.perDay} push campaigns a day`,
        );
      }
      const userId = tenant.actor.kind === 'staff' ? tenant.actor.userId : null;
      const { rows } = await tx.execute<CampaignRow>(sql`
        INSERT INTO messaging.push_campaigns (shop_id, title, body, path, created_by)
             VALUES (${tenant.shopId}, ${title}, ${body}, ${path}, ${userId})
        RETURNING id, title, body, path, status, cursor_id, sent, failed, gone, created_at, sent_at`);
      const campaign = toCampaign(rows[0]!);
      await recordAudit(tx, tenant.shopId, {
        action: 'push_campaign.sent',
        subjectType: 'pushCampaign',
        subjectId: campaign.id,
        ...actorColumnsOf(tenant.actor),
        details: { title, path },
      });
      return { ok: true, value: campaign };
    });
  }

  /** The campaigns still being pushed, of every shop, the oldest first. */
  async due(limit = 50): Promise<{ shopId: string; id: string }[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; id: string }>(sql`
        SELECT shop_id, id FROM messaging.push_campaigns
         WHERE status = 'sending'
         ORDER BY created_at, id
         LIMIT ${limit}`),
    );
    return rows.map((row) => ({ shopId: row.shop_id, id: row.id }));
  }

  /**
   * Pushes a campaign to its next browsers, at most `batch`, from where it got to, in marketing
   * hours alone; the campaign sent once none are left. Forgets the subscriptions their push
   * service says are gone, and those that failed too often in a row.
   */
  async pushNext(
    shopId: string,
    id: string,
    at: Date = new Date(),
    batch: number = SHOPPER_PUSH_LIMITS.batch,
  ): Promise<PushCampaignRound> {
    const sender = this.sender;
    if (!sender) return { outcome: 'none' };
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<CampaignRow>(sql`
        SELECT id, title, body, path, status, cursor_id, sent, failed, gone, created_at, sent_at
          FROM messaging.push_campaigns
         WHERE shop_id = ${shopId} AND id = ${id}
         FOR UPDATE SKIP LOCKED`);
      const campaign = rows[0];
      if (!campaign || campaign.status !== 'sending') return { outcome: 'none' as const };
      const { timezone } = await shopProfile(tx, shopId);
      const hours = marketingHours(timezone, at);
      if (!hours.open) return { outcome: 'waiting' as const, until: hours.nextOpen };

      const subscriptions = await nextSubscriptionsIn(tx, shopId, campaign.cursor_id, batch);
      const outcomes = await pushAll(sender, subscriptions, {
        title: campaign.title,
        body: campaign.body,
        url: campaign.path,
        tag: `pcmp_${campaign.id}`.slice(0, 64),
      });
      const ids = (wanted: PushOutcome) =>
        outcomes.filter((each) => each.outcome === wanted).map((each) => each.id);
      const [sent, failed, gone] = [ids('sent'), ids('failed'), ids('gone')];
      if (sent.length > 0) {
        await tx.execute(sql`
          UPDATE messaging.shopper_push_subscriptions SET last_sent_at = ${at.toISOString()}, failures = 0
           WHERE shop_id = ${shopId} AND id = ANY (${sql.param(sent)}::uuid[])`);
      }
      if (failed.length > 0) {
        await tx.execute(sql`
          UPDATE messaging.shopper_push_subscriptions SET failures = failures + 1
           WHERE shop_id = ${shopId} AND id = ANY (${sql.param(failed)}::uuid[])`);
      }
      await tx.execute(sql`
        DELETE FROM messaging.shopper_push_subscriptions
         WHERE shop_id = ${shopId}
           AND (id = ANY (${sql.param(gone)}::uuid[]) OR failures >= ${SHOPPER_PUSH_LIMITS.failures})`);
      const done = subscriptions.length < batch;
      const last = subscriptions.at(-1)?.id ?? campaign.cursor_id;
      await tx.execute(sql`
        UPDATE messaging.push_campaigns
           SET cursor_id = ${last}, sent = sent + ${sent.length}, failed = failed + ${failed.length},
               gone = gone + ${gone.length},
               status = ${done ? 'sent' : 'sending'},
               sent_at = ${done ? at.toISOString() : null}
         WHERE shop_id = ${shopId} AND id = ${id}`);
      return { outcome: 'pushed' as const, sent: sent.length, done };
    });
  }
}

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** The shop's subscriptions after `cursor`, in ID order, at most `batch`. */
async function nextSubscriptionsIn(
  tx: Tx,
  shopId: string,
  cursor: string | null,
  batch: number,
): Promise<SubscriptionRow[]> {
  const { rows } = await tx.execute<SubscriptionRow>(sql`
    SELECT id, endpoint, p256dh, auth FROM messaging.shopper_push_subscriptions
     WHERE shop_id = ${shopId} ${cursor === null ? sql`` : sql`AND id > ${cursor}`}
     ORDER BY id
     LIMIT ${batch}`);
  return rows;
}

/** `message` pushed to each of `subscriptions`, so many at once: what became of each. */
async function pushAll(
  sender: WebPushSender,
  subscriptions: readonly SubscriptionRow[],
  message: object,
): Promise<{ id: string; outcome: PushOutcome }[]> {
  const outcomes: { id: string; outcome: PushOutcome }[] = [];
  for (let start = 0; start < subscriptions.length; start += SHOPPER_PUSH_LIMITS.concurrency) {
    const round = subscriptions.slice(start, start + SHOPPER_PUSH_LIMITS.concurrency);
    outcomes.push(
      ...(await Promise.all(
        round.map(async (each) => ({
          id: each.id,
          // A browser whose subscription was not one a push service gave is forgotten unasked.
          outcome: isPushServiceEndpoint(each.endpoint)
            ? await sender.send(each, message)
            : ('gone' as const),
        })),
      )),
    );
  }
  return outcomes;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const textOf = (body: unknown, name: string): string | undefined => {
  const value = (body as Record<string, unknown> | null)?.[name];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Shoppers' push subscriptions, as storefronts pass them on (ADR-833): `POST
 * /storefront/shops/{shop}/push-subscriptions` keeps one, `…/remove` forgets one. 404 while
 * Hatti pushes nothing; 422 says what was wrong. The host application checks the storefront key
 * before any of this runs.
 */
@Controller(pushSubscriptionsPath(':shopId').slice(1))
export class StorefrontPushController {
  constructor(private readonly pushes: ShopperPushService) {}

  @Post()
  @HttpCode(204)
  async subscribe(@Param('shopId') shopId: string, @Body() body: unknown): Promise<void> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const result = await this.pushes.subscribe(shopId, {
      endpoint: textOf(body, 'endpoint'),
      p256dh: textOf(body, 'p256dh'),
      auth: textOf(body, 'auth'),
      locale: textOf(body, 'locale'),
    });
    if (!result) throw new NotFoundException();
    if (!result.ok) {
      throw new UnprocessableEntityException({
        errors: result.errors.map(({ field, message }) => ({ field: field.join('.'), message })),
      } satisfies PushSubscribeErrorResponse);
    }
  }

  @Post('remove')
  @HttpCode(204)
  async unsubscribe(@Param('shopId') shopId: string, @Body() body: unknown): Promise<void> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    await this.pushes.unsubscribe(shopId, textOf(body, 'endpoint') ?? '');
  }
}
