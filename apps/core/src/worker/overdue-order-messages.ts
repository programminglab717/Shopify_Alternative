import { shopProfile } from '@hatti/api';
import type { Database } from '@hatti/db';
import type { Logger } from '@hatti/logger';
import { settingsIn, type MessagesService } from '@hatti/messaging/public';
import { overdueFirstCallsIn } from '@hatti/orders/public';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';

/** How often the same shop is told on WhatsApp of its overdue orders at most: three hours. */
export const OVERDUE_MESSAGE_EVERY_MS = 3 * 60 * 60_000;

/**
 * Tells the shop on WhatsApp, at its alerts number, when orders have waited for their first call
 * longer than its first-call target (COD-05, ADR-680), as the Confirmation Desk counts them and
 * the push does (ADR-627): at most once every three hours while any wait, within its calling
 * hours alone, so that a day's backlog is a few messages of the shop's credit, not one an hour.
 * Nothing while the shop gives no number or turned the alert off, nor for a shop without a
 * target. The shops are found with the system role; each is read in its own transaction.
 */
export class OverdueOrderMessages {
  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many shops were told. */
  async sweep(at: Date = new Date()): Promise<number> {
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT shop_id FROM orders.order_settings WHERE first_call_minutes IS NOT NULL`),
    );
    let told = 0;
    for (const { shop_id: shopId } of shops) {
      try {
        const queued = await this.database.tenant(shopId, async (tx) => {
          const { alertsPhone } = await settingsIn(tx, shopId);
          if (!alertsPhone) return null;
          const { count, callingNow } = await overdueFirstCallsIn(tx, shopId, at);
          if (count === 0 || !callingNow) return null;
          const block = Math.floor(at.getTime() / OVERDUE_MESSAGE_EVERY_MS);
          return this.messages.queueIn(tx, shopId, {
            kind: 'orders_overdue',
            recipient: alertsPhone,
            dedupeKey: `orders_overdue:${block}`,
            variables: { shop: (await shopProfile(tx, shopId)).name, orders: String(count) },
            channel: 'whatsapp',
          });
        });
        if (queued) told += 1;
      } catch (error) {
        // One shop's failure is not the others': it is told on the next sweep.
        this.logger?.warn({ err: error, shopId }, 'overdue orders not told');
      }
    }
    return told;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'overdue orders message sweep failed'),
    );
  }
}
