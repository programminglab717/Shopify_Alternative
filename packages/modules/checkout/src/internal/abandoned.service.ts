import {
  InputChecker,
  PublicSite,
  StorefrontSite,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { secretToken, sha256 } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { MessagesService } from '@hatti/messaging/public';
import { OrderService } from '@hatti/orders/public';
import { parsePkMobile } from '@hatti/pk';
import type { CartJson } from '@hatti/storefront-api';
import { Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  ABANDONED,
  REMINDER_DELAYS,
  REMINDER_LINK_PATH,
  contactLinesOf,
  permalinkOf,
  type ContactLineValue,
  type ReminderDelay,
} from './abandoned.js';
import { CheckoutEvents, type RecoverySettingsUpdatedPayload } from './events.js';
import { recoverySettings } from './schema.js';

/** A checkout its shopper left after typing their number (CHK-12, ADR-393). */
export interface AbandonedCheckoutRecord {
  id: string;
  /** When they started it, and last typed their number. */
  createdAt: Date;
  contactAt: Date;
  name: string | null;
  /** In E.164. */
  phone: string;
  lines: ContactLineValue[];
  subtotal: bigint;
  /** The shop's, as its prices are. */
  currency: string;
  remindedAt: Date | null;
  /** The order the same number placed since, after the reminder or not. */
  recoveredOrder: { id: string; number: number } | null;
}

/** Whether, and how long after the shopper left, the shop reminds them; null for never. */
export interface RecoverySettingsRecord {
  reminderAfterMinutes: ReminderDelay | null;
}

const DEFAULT_SETTINGS: RecoverySettingsRecord = { reminderAfterMinutes: null };

/** A reminder's secret: 128 random bits, as a checkout's own. */
const TOKEN_BYTES = 16;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** The shop's recovery settings, in the caller's transaction `tx`. */
export async function recoverySettingsIn(tx: Tx, shopId: string): Promise<RecoverySettingsRecord> {
  const [row] = await tx
    .select({ minutes: recoverySettings.reminderAfterMinutes })
    .from(recoverySettings)
    .where(eq(recoverySettings.shopId, shopId));
  return row ? { reminderAfterMinutes: row.minutes as ReminderDelay | null } : DEFAULT_SETTINGS;
}

/**
 * Keeps the name and number the shopper typed on the checkout, with the cart's items and their
 * subtotal now, in the caller's transaction `tx` (ADR-393): for the shop to see who left without
 * ordering, and remind them. A number that is not a Pakistani mobile keeps nothing, and a blank
 * name keeps the one typed before. A completed checkout keeps nothing more. Whether it kept them.
 */
export async function keepContactIn(
  tx: Tx,
  shopId: string,
  checkoutId: string,
  typed: { name: string; phone: string },
  cart: Pick<CartJson, 'items' | 'subtotal'>,
): Promise<boolean> {
  const phone = parsePkMobile(typed.phone)?.e164;
  if (!phone || cart.items.length === 0) return false;
  const name = typed.name.trim().slice(0, 100) || null;
  const { rows } = await tx.execute(sql`
    UPDATE checkout.checkouts
       SET contact_name = coalesce(${name}, CASE WHEN contact_phone = ${phone} THEN contact_name END),
           contact_phone = ${phone},
           contact_at = now(),
           contact_lines = ${JSON.stringify(contactLinesOf(cart))}::jsonb,
           contact_subtotal = ${cart.subtotal},
           kept_until = now() + make_interval(days => ${ABANDONED.keptDays})
     WHERE shop_id = ${shopId} AND id = ${checkoutId} AND completed_at IS NULL
    RETURNING id`);
  return rows.length > 0;
}

/**
 * The checkouts the number left in the shop, in the last days an order recovers, marked as
 * recovered by `orderId`, which it placed: in the caller's transaction `tx` (ADR-393). The
 * checkout that placed it, if it was reminded first, too.
 */
export async function recoverIn(
  tx: Tx,
  shopId: string,
  phone: string,
  orderId: string,
  placedFrom: string | null = null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE checkout.checkouts
       SET recovered_order_id = ${orderId}
     WHERE shop_id = ${shopId} AND contact_phone = ${phone} AND recovered_order_id IS NULL
       AND contact_at > now() - make_interval(days => ${ABANDONED.recoveredWithinDays})
       AND (completed_at IS NULL OR (id = ${placedFrom} AND reminded_at IS NOT NULL))`);
}

type AbandonedRow = {
  id: string;
  created_at: string | Date;
  contact_at: string | Date;
  contact_name: string | null;
  contact_phone: string;
  contact_lines: ContactLineValue[] | null;
  contact_subtotal: string | number | null;
  reminded_at: string | Date | null;
  recovered_order_id: string | null;
};

/**
 * Checkouts shoppers left after typing their number (CHK-12, ADR-393): the shop's list of them,
 * its setting for reminding them on WhatsApp, and the worker's sweep that does, once each, with a
 * link back to their items; an order the same number places then recovers it.
 */
@Injectable()
export class AbandonedCheckoutService {
  constructor(
    private readonly db: Database,
    private readonly messages: MessagesService,
    private readonly orders: OrderService,
    private readonly storefronts: StorefrontSite,
    /** Where reminders' links are: the core's own address. */
    @Optional() private readonly site?: PublicSite,
  ) {}

  settings(tenant: TenantContext): Promise<RecoverySettingsRecord> {
    return this.db.tenant(tenant.shopId, (tx) => recoverySettingsIn(tx, tenant.shopId));
  }

  /**
   * Sets how long after a shopper leaves the shop reminds them, of 30, 60, 180 or 600 minutes;
   * null for never. Records `recovery_settings.updated` when it changed.
   */
  async updateSettings(
    tenant: TenantContext,
    input: { reminderAfterMinutes: number | null },
  ): Promise<MutationResult<RecoverySettingsRecord>> {
    const minutes = input.reminderAfterMinutes;
    if (minutes !== null && !(REMINDER_DELAYS as readonly number[]).includes(minutes)) {
      const check = new InputChecker();
      check.add(
        ['input', 'reminderAfterMinutes'],
        'INVALID',
        `must be one of ${REMINDER_DELAYS.join(', ')} minutes, or none`,
      );
      return { ok: false, errors: check.errors };
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await recoverySettingsIn(tx, tenant.shopId);
      const next: RecoverySettingsRecord = {
        reminderAfterMinutes: minutes as ReminderDelay | null,
      };
      await tx
        .insert(recoverySettings)
        .values({ shopId: tenant.shopId, reminderAfterMinutes: minutes })
        .onConflictDoUpdate({
          target: recoverySettings.shopId,
          set: { reminderAfterMinutes: minutes, updatedAt: sql`now()` },
        });
      if (before.reminderAfterMinutes !== next.reminderAfterMinutes) {
        await appendEvent<RecoverySettingsUpdatedPayload>(tx, tenant.shopId, {
          type: CheckoutEvents.RecoverySettingsUpdated,
          aggregateType: 'recovery_settings',
          aggregateId: tenant.shopId,
          payload: { reminderAfterMinutes: next.reminderAfterMinutes },
        });
      }
      return { ok: true, value: next };
    });
  }

  /**
   * The shop's abandoned checkouts, the latest left first, `first` at a time after the one `after`
   * names: those not completed, or completed only after a reminder, kept 30 days.
   */
  async list(
    tenant: TenantContext,
    options: { first?: number; after?: string | null } = {},
  ): Promise<AbandonedCheckoutRecord[]> {
    const first = Math.min(Math.max(options.first ?? 50, 1), 250);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { shopId } = tenant;
      let after: { contact_at: string | Date; id: string } | null = null;
      if (options.after) {
        const { rows } = await tx.execute<{ contact_at: string | Date; id: string }>(sql`
          SELECT contact_at, id FROM checkout.checkouts
           WHERE shop_id = ${shopId} AND id = ${options.after}::uuid
             AND contact_phone IS NOT NULL`);
        after = rows[0] ?? null;
        if (!after) return [];
      }
      const { rows } = await tx.execute<AbandonedRow>(sql`
        SELECT id, created_at, contact_at, contact_name, contact_phone, contact_lines,
               contact_subtotal, reminded_at, recovered_order_id
          FROM checkout.checkouts
         WHERE shop_id = ${shopId} AND contact_phone IS NOT NULL
           AND (completed_at IS NULL OR reminded_at IS NOT NULL)
           ${
             after
               ? sql`AND (contact_at, id) < (${toDate(after.contact_at).toISOString()}::timestamptz, ${after.id}::uuid)`
               : sql``
           }
         ORDER BY contact_at DESC, id DESC
         LIMIT ${first}`);
      const { currency } = await shopProfile(tx, shopId);
      const recovered = rows.flatMap((row) => row.recovered_order_id ?? []);
      const numbers = new Map<string, number>();
      for (const id of recovered) {
        const order = await this.orders.orderOf(tx, shopId, id);
        if (order) numbers.set(id, order.number);
      }
      return rows.map((row) => {
        const number = row.recovered_order_id ? numbers.get(row.recovered_order_id) : undefined;
        return {
          id: row.id,
          createdAt: toDate(row.created_at),
          contactAt: toDate(row.contact_at),
          name: row.contact_name,
          phone: row.contact_phone,
          lines: row.contact_lines ?? [],
          subtotal: BigInt(row.contact_subtotal ?? 0),
          currency,
          remindedAt: row.reminded_at ? toDate(row.reminded_at) : null,
          recoveredOrder:
            row.recovered_order_id && number !== undefined
              ? { id: row.recovered_order_id, number }
              : null,
        };
      });
    });
  }

  /**
   * Reminds, once each, shoppers who left a checkout as long ago as their shop says, within the
   * last day: on WhatsApp, with a link back to their items. A number that ordered meanwhile, by
   * any way, is not reminded: its checkout is recovered by that order. The shops are found with
   * the system role through the reminders' index, each reminded in its own transaction; one that
   * fails is tried again on the next sweep, and the rest go on. How many it reminded.
   */
  async remindDue(
    at: Date = new Date(),
    failed?: (shopId: string, error: unknown) => void,
  ): Promise<number> {
    const since = new Date(at.getTime() - ABANDONED.remindWithinHours * 3_600_000);
    const { rows: shops } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT c.shop_id
          FROM checkout.checkouts c
          JOIN checkout.recovery_settings s ON s.shop_id = c.shop_id
         WHERE c.contact_phone IS NOT NULL AND c.reminded_at IS NULL AND c.completed_at IS NULL
           AND c.recovered_order_id IS NULL AND s.reminder_after_minutes IS NOT NULL
           AND c.contact_at > ${since.toISOString()}::timestamptz
           AND c.contact_at <= ${at.toISOString()}::timestamptz
                               - make_interval(mins => s.reminder_after_minutes)`),
    );
    let reminded = 0;
    for (const { shop_id: shopId } of shops) {
      try {
        reminded += await this.db.tenant(shopId, (tx) => this.#remindIn(tx, shopId, at, since));
      } catch (error) {
        if (!failed) throw error;
        failed(shopId, error);
      }
    }
    return reminded;
  }

  async #remindIn(tx: Tx, shopId: string, at: Date, since: Date): Promise<number> {
    const settings = await recoverySettingsIn(tx, shopId);
    if (settings.reminderAfterMinutes === null) return 0;
    const before = new Date(at.getTime() - settings.reminderAfterMinutes * 60_000);
    const { rows } = await tx.execute<{
      id: string;
      contact_name: string | null;
      contact_phone: string;
      contact_at: string | Date;
    }>(sql`
      SELECT id, contact_name, contact_phone, contact_at FROM checkout.checkouts
       WHERE shop_id = ${shopId} AND contact_phone IS NOT NULL AND reminded_at IS NULL
         AND completed_at IS NULL AND recovered_order_id IS NULL
         AND contact_at > ${since.toISOString()}::timestamptz
         AND contact_at <= ${before.toISOString()}::timestamptz
       ORDER BY contact_at
       FOR UPDATE SKIP LOCKED`);
    if (rows.length === 0) return 0;
    const profile = await shopProfile(tx, shopId);
    let reminded = 0;
    for (const row of rows) {
      // Ordered meanwhile, by the storefront or otherwise: nothing to remind them of.
      const ordered = await this.orders.latestOrderFromIn(
        tx,
        shopId,
        row.contact_phone,
        toDate(row.contact_at),
      );
      if (ordered) {
        await tx.execute(sql`
          UPDATE checkout.checkouts SET recovered_order_id = ${ordered.id}
           WHERE shop_id = ${shopId} AND id = ${row.id}`);
        continue;
      }
      const token = secretToken('', TOKEN_BYTES);
      const url = this.#site().url(`/${REMINDER_LINK_PATH}/${token}`);
      await this.messages.queueIn(tx, shopId, {
        kind: 'checkout_reminder',
        recipient: row.contact_phone,
        dedupeKey: `checkout_reminder:${row.id}`,
        variables: { name: row.contact_name ?? '', shop: profile.name, url },
      });
      await tx.execute(sql`
        UPDATE checkout.checkouts
           SET reminded_at = ${at.toISOString()}::timestamptz, reminder_token_hash = ${sha256(token)}
         WHERE shop_id = ${shopId} AND id = ${row.id}`);
      reminded += 1;
    }
    return reminded;
  }

  /**
   * Where a reminder's link sends the shopper: their shop's storefront, at the cart permalink of
   * the items they left, which fills a cart and opens its checkout; null for a link it knows not.
   */
  async reminderTarget(token: string): Promise<string | null> {
    if (!TOKEN.test(token)) return null;
    const { rows } = await this.db.app.execute<{ shop_id: string; checkout_id: string }>(
      sql`SELECT * FROM checkout.resolve_reminder(${sha256(token)})`,
    );
    const found = rows[0];
    if (!found) return null;
    return this.db.tenant(found.shop_id, async (tx) => {
      const { rows: lines } = await tx.execute<{ contact_lines: ContactLineValue[] | null }>(sql`
        SELECT contact_lines FROM checkout.checkouts
         WHERE shop_id = ${found.shop_id} AND id = ${found.checkout_id}`);
      if (lines.length === 0) return null;
      const storefront = this.storefronts.url((await shopProfile(tx, found.shop_id)).handle);
      return `${storefront}${permalinkOf(lines[0]!.contact_lines ?? [])}`;
    });
  }

  #site(): PublicSite {
    if (!this.site) throw new Error('Reminders need the public site, for their links');
    return this.site;
  }
}
