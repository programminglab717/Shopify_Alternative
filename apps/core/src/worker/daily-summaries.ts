import { shopProfile } from '@hatti/api';
import type { Database } from '@hatti/db';
import type { Logger } from '@hatti/logger';
import { settingsIn, type MessagesService } from '@hatti/messaging/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { yesterdayIn } from '@hatti/orders/public';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';

/** From this hour of the morning by the shop's clock, the day before is told. */
export const DAILY_SUMMARY_HOUR = 9;

/** "Sun 11 Oct" for "2026-10-11": the day as its owner reads it. */
function dayName(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .format(new Date(`${date}T00:00:00Z`))
    .replace(',', '');
}

/**
 * Tells each shop on WhatsApp each morning how the day before went (ANL-07, ADR-386): its orders
 * and sales, its parcels delivered and turned back, and the cash on delivery still to come; at
 * the shop's alerts number, from nine in the morning by its clock, once a day. Nothing while the
 * shop gives no number or turned the summary off, nor for a day with no orders and no parcels
 * delivered or turned back. The shops are found with the system role, which sees every shop;
 * each is told in its own transaction.
 */
export class DailySummaries {
  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many shops it told. */
  async sweep(at: Date = new Date()): Promise<number> {
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT shop_id FROM messaging.settings
         WHERE alerts_phone IS NOT NULL AND NOT ('daily_summary' = ANY (disabled))`),
    );
    let told = 0;
    for (const { shop_id: shopId } of shops) {
      try {
        if (await this.#tell(shopId, at)) told += 1;
      } catch (error) {
        // One shop's failure is not the others': it is told on the next sweep.
        this.logger?.warn({ err: error, shopId }, 'daily summary not sent');
      }
    }
    return told;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'daily summaries sweep failed'),
    );
  }

  async #tell(shopId: string, at: Date): Promise<boolean> {
    return this.database.tenant(shopId, async (tx) => {
      const day = await yesterdayIn(tx, shopId, at);
      if (day.hour < DAILY_SUMMARY_HOUR) return false;
      const quiet =
        day.sales.count === 0 && day.delivered.count === 0 && day.returnedToOrigin.count === 0;
      if (quiet) return false;
      const { alertsPhone } = await settingsIn(tx, shopId);
      if (!alertsPhone) return false;
      const shop = await shopProfile(tx, shopId);
      const rupees = (amount: bigint) => formatMoney(money(amount, shop.currency as CurrencyCode));
      const id = await this.messages.queueIn(tx, shopId, {
        kind: 'daily_summary',
        recipient: alertsPhone,
        // Once a day.
        dedupeKey: `daily_summary:${day.date}`,
        variables: {
          shop: shop.name,
          date: dayName(day.date),
          orders: String(day.sales.count),
          sales: rupees(day.sales.total),
          delivered: String(day.delivered.count),
          returned: String(day.returnedToOrigin.count),
          cash: rupees(day.cashToCollect.total),
        },
        channel: 'whatsapp',
      });
      return id !== null;
    });
  }
}
