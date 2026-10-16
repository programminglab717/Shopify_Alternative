import { shopProfile } from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import { parsePkMobile } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { automationOnIn } from './automations.service.js';
import { MessagesService } from './messages.service.js';
import type { MessageLanguage } from './templates.js';

/** How long a shopper's wish to hear of a variant is kept, untold (ADR-429). */
export const STOCK_WATCH_DAYS = 90;

/** The variants one number may wait for in a shop at once, so a form cannot be flooded. */
export const STOCK_WATCHES_PER_PHONE = 20;

/** A shopper's wish, through the storefront's form, to hear when a sold-out variant is back. */
export interface StockWatchInput {
  variantId: string;
  productId: string;
  /** A Pakistani mobile number, as typed. */
  phone: string;
  language: MessageLanguage;
}

export type StockWatchOutcome =
  { ok: true; created: boolean } | { ok: false; errors: { field: string; message: string }[] };

/** A shopper waiting to hear of a variant. */
export interface StockWatchRecord {
  id: string;
  variantId: string;
  productId: string;
  /** In E.164. */
  phone: string;
  language: MessageLanguage;
  createdAt: Date;
}

type WatchRow = {
  id: string;
  variant_id: string;
  product_id: string;
  phone: string;
  language: MessageLanguage;
  created_at: string | Date;
};

/**
 * Back in stock (MKT-04, ADR-429): shoppers who found a variant sold out on the storefront and
 * left their number to hear when it is for sale online again, while the shop's automation is on;
 * and telling them, once each, on WhatsApp from Hatti's number, with the product's link. A wish is
 * kept until told, or for 90 days.
 */
@Injectable()
export class StockWatchService {
  constructor(
    private readonly db: Database,
    private readonly messages: MessagesService,
  ) {}

  /**
   * Keeps a shopper's wish to hear of a variant, which the caller found sold out on the shop's
   * storefront: refused while the shop's automation is off, or for a number not a Pakistani
   * mobile, or one waiting for too many variants. Asked again while waiting, it keeps the first.
   * Whether it was new.
   */
  async watch(shopId: string, input: StockWatchInput): Promise<StockWatchOutcome> {
    const phone = parsePkMobile(input.phone)?.e164;
    if (!phone) {
      return {
        ok: false,
        errors: [{ field: 'phone', message: 'Enter a Pakistani mobile number' }],
      };
    }
    return this.db.tenant(shopId, async (tx) => {
      if (!(await automationOnIn(tx, shopId, 'back_in_stock'))) {
        return {
          ok: false,
          errors: [{ field: 'base', message: "This shop doesn't send back in stock messages" }],
        };
      }
      const { rows: waiting } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM messaging.stock_watches
         WHERE shop_id = ${shopId} AND phone = ${phone} AND notified_at IS NULL
           AND created_at > now() - make_interval(days => ${STOCK_WATCH_DAYS})`);
      if (waiting[0]!.count >= STOCK_WATCHES_PER_PHONE) {
        return {
          ok: false,
          errors: [{ field: 'phone', message: 'This number is waiting for enough products' }],
        };
      }
      // A wish older than the days it is kept makes way for a new one.
      await tx.execute(sql`
        DELETE FROM messaging.stock_watches
         WHERE shop_id = ${shopId} AND variant_id = ${input.variantId} AND phone = ${phone}
           AND notified_at IS NULL
           AND created_at <= now() - make_interval(days => ${STOCK_WATCH_DAYS})`);
      const { rows } = await tx.execute(sql`
        INSERT INTO messaging.stock_watches
               (shop_id, id, variant_id, product_id, phone, language)
        VALUES (${shopId}, ${newId()}, ${input.variantId}, ${input.productId}, ${phone},
                ${input.language})
        ON CONFLICT (shop_id, variant_id, phone) WHERE notified_at IS NULL DO NOTHING
        RETURNING id`);
      return { ok: true, created: rows.length > 0 };
    });
  }

  /**
   * The shoppers waiting to hear of `variantId`, within the days a wish is kept, the first to ask
   * first: in the caller's transaction `tx`, locked for telling them.
   */
  async waitingIn(tx: Tx, shopId: string, variantId: string): Promise<StockWatchRecord[]> {
    const { rows } = await tx.execute<WatchRow>(sql`
      SELECT id, variant_id, product_id, phone, language, created_at
        FROM messaging.stock_watches
       WHERE shop_id = ${shopId} AND variant_id = ${variantId} AND notified_at IS NULL
         AND created_at > now() - make_interval(days => ${STOCK_WATCH_DAYS})
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED`);
    return rows.map((row) => ({
      id: row.id,
      variantId: row.variant_id,
      productId: row.product_id,
      phone: row.phone,
      language: row.language,
      createdAt: toDate(row.created_at),
    }));
  }

  /**
   * Tells each of `watches` that their variant is for sale again, in the caller's transaction
   * `tx`: `product` names it, `url` is its page. Each is told once, then kept as told. How many
   * were told.
   */
  async notifyIn(
    tx: Tx,
    shopId: string,
    watches: readonly StockWatchRecord[],
    message: { product: string; url: string },
  ): Promise<number> {
    if (watches.length === 0) return 0;
    const { name: shop } = await shopProfile(tx, shopId);
    for (const watch of watches) {
      await this.messages.queueIn(tx, shopId, {
        kind: 'back_in_stock',
        recipient: watch.phone,
        dedupeKey: `back_in_stock:${watch.id}`,
        variables: { shop, product: message.product, url: message.url },
        channel: 'whatsapp',
        language: watch.language,
      });
    }
    await tx.execute(sql`
      UPDATE messaging.stock_watches SET notified_at = now()
       WHERE shop_id = ${shopId}
         AND id = ANY(${sql.param(watches.map((watch) => watch.id))}::uuid[])`);
    return watches.length;
  }
}
