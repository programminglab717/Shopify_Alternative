import { shopProfile, type PublicSite } from '@hatti/api';
import type { Database } from '@hatti/db';
import type { Logger } from '@hatti/logger';
import { settingsIn, type MessagesService } from '@hatti/messaging/public';
import {
  COMPONENT_WORDS,
  STATUS_WORDS,
  type StatusShopNotice,
  type StatusSubscriptionsService,
} from '@hatti/trust/public';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';

/**
 * Tells every shop on WhatsApp of Hatti's outages (BIL-06, ADR-544): when one begins, or
 * maintenance putting a part out of service is set, and when it ends; at the shop's alerts
 * number, from Hatti's number and at Hatti's cost, in the shop's language, each once. An update
 * is marked told once every shop with a number has it queued; a shop that fails is tried again
 * next sweep, the others not twice. The shops are found with the system role, which sees every
 * shop; each is told in its own transaction.
 */
export class StatusShopNotices {
  constructor(
    private readonly subscriptions: Pick<
      StatusSubscriptionsService,
      'shopNoticesDue' | 'shopNoticeSent'
    >,
    private readonly database: Database,
    private readonly messages: Pick<MessagesService, 'queueIn'>,
    private readonly site: PublicSite,
    private readonly logger?: Pick<Logger, 'warn'>,
  ) {}

  /** One sweep at `at`: how many messages it queued. */
  async sweep(at: Date = new Date()): Promise<number> {
    const due = await this.subscriptions.shopNoticesDue(at);
    if (due.length === 0) return 0;
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT shop_id FROM messaging.settings WHERE alerts_phone IS NOT NULL ORDER BY shop_id`),
    );
    let queued = 0;
    for (const notice of due) {
      let failed = false;
      for (const { shop_id: shopId } of shops) {
        try {
          if (await this.#tell(shopId, notice)) queued += 1;
        } catch (error) {
          failed = true;
          this.logger?.warn({ err: error, shopId }, 'status notice not queued');
        }
      }
      if (!failed) await this.subscriptions.shopNoticeSent(notice.updateId, at);
    }
    return queued;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'status notices sweep failed'),
    );
  }

  async #tell(shopId: string, notice: StatusShopNotice): Promise<boolean> {
    return this.database.tenant(shopId, async (tx) => {
      const { alertsPhone, language } = await settingsIn(tx, shopId);
      if (!alertsPhone) return false;
      const urdu = language === 'ur';
      const id = await this.messages.queueIn(tx, shopId, {
        kind: 'status_update',
        recipient: alertsPhone,
        // Once for each update, however often the sweep runs.
        dedupeKey: `status_update:${notice.updateId}`,
        variables: {
          shop: (await shopProfile(tx, shopId)).name,
          title: (urdu && notice.titleUr) || notice.title,
          status: STATUS_WORDS[notice.status][urdu ? 'ur' : 'en'],
          touches: notice.components
            .map((component) => COMPONENT_WORDS[component][urdu ? 'ur' : 'en'])
            .join(urdu ? '، ' : ', '),
          url: this.site.url('status'),
        },
        channel: 'whatsapp',
      });
      return id !== null;
    });
  }
}
