import { InputChecker, type MutationResult, type TenantContext } from '@hatti/api';
import { bundlesOfVariantsIn } from '@hatti/catalog/public';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { LocationService, StockService } from '@hatti/inventory/public';
import { Injectable } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { CheckoutEvents, type StockHoldUpdatedPayload } from './events.js';
import { holdSettings } from './schema.js';

/** A checkout's units held at a location (ADR-715), as kept. */
export interface HeldLineValue {
  variantId: string;
  locationId: string;
  quantity: number;
}

export const HOLD_LIMITS = { minMinutes: 5, maxMinutes: 60 } as const;

/** How long the shop's checkouts hold their carts' stock, in the caller's `tx`; null for none. */
export async function holdMinutesIn(tx: Tx, shopId: string): Promise<number | null> {
  const [row] = await tx
    .select({ minutes: holdSettings.minutes })
    .from(holdSettings)
    .where(eq(holdSettings.shopId, shopId));
  return row?.minutes ?? null;
}

/** What a checkout's hold is recorded against in the stock's ledger. */
function holdReference(checkoutId: string): string {
  return `hatti://checkouts/${checkoutId}`;
}

const SYSTEM = (shopId: string) => ({ shopId, actor: 'system' as const });

/**
 * Stock held while a shopper checks out (CHK-02, ADR-715): where the shop asks, a checkout begun
 * reserves its cart's units, a bundle's as its parts, at the location the order would ship from,
 * for the shop's minutes. Other shoppers see them gone; the shopper holding them sees them still
 * theirs. A hold is given back when the order takes the units, when another checkout of the same
 * cart begins, or when its minutes run out and the sweep comes. Stock too short to hold it all
 * holds none: placing the order checks the stock again, as it always did.
 */
export class StockHolds {
  readonly #stock = new StockService();
  readonly #locations: LocationService;

  constructor(private readonly db: Database) {
    this.#locations = new LocationService(db);
  }

  /**
   * Holds `items` for checkout `checkoutId` of cart `cartId`, in the caller's `tx`, after giving
   * back what the cart's other checkouts held; until when, or null when nothing is held.
   */
  async holdIn(
    tx: Tx,
    shopId: string,
    checkout: { id: string; cartId: string },
    items: readonly { variantId: string; quantity: number }[],
  ): Promise<Date | null> {
    const minutes = await holdMinutesIn(tx, shopId);
    // Given back even when the shop no longer holds: units a cart held are its shopper's still.
    await this.#releaseWhere(tx, shopId, sql`cart_id = ${checkout.cartId}`);
    if (minutes === null || items.length === 0) return null;
    const parts = await partsOf(tx, shopId, items);
    const location = await this.#locations.forOrderIn(tx, shopId, parts);
    const lines: HeldLineValue[] = parts.map((line) => ({ ...line, locationId: location.id }));
    const reserved = await this.#stock.reserve(tx, SYSTEM(shopId), lines, {
      referenceDocumentUri: holdReference(checkout.id),
    });
    // Too short to hold it all, or nothing tracked to hold.
    if (!reserved.ok || !reserved.adjustment) return null;
    const { rows } = await tx.execute<{ held_until: string }>(sql`
      UPDATE checkout.checkouts
         SET held = ${JSON.stringify(lines)}::jsonb,
             held_until = now() + make_interval(mins => ${minutes})
       WHERE shop_id = ${shopId} AND id = ${checkout.id}
      RETURNING held_until`);
    return rows[0] ? new Date(rows[0].held_until) : null;
  }

  /** Gives back what checkout `checkoutId` holds, in the caller's `tx`; what it held, if any. */
  async releaseIn(tx: Tx, shopId: string, checkoutId: string): Promise<HeldLineValue[]> {
    const released = await this.#releaseWhere(tx, shopId, sql`id = ${checkoutId}`);
    return released.flatMap((row) => row.held);
  }

  /**
   * Gives back up to `limit` holds whose minutes ran out by `at`, across shops: found with the
   * system role, and each shop's given back in its own transaction. How many it gave back. A shop
   * whose transaction fails is told to `failed`, and the rest go on; without it, its error is
   * thrown.
   */
  async releaseLapsed(
    at: Date,
    limit: number,
    failed?: (shopId: string, error: unknown) => void,
  ): Promise<number> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; id: string }>(sql`
        SELECT shop_id, id FROM checkout.checkouts
         WHERE held_until <= ${at.toISOString()}
         ORDER BY held_until
         LIMIT ${limit}`),
    );
    const byShop = new Map<string, string[]>();
    for (const row of rows) byShop.set(row.shop_id, [...(byShop.get(row.shop_id) ?? []), row.id]);
    let released = 0;
    for (const [shopId, ids] of byShop) {
      try {
        const gone = await this.db.tenant(shopId, (tx) =>
          this.#releaseWhere(
            tx,
            shopId,
            sql`id = ANY(${sql.param(ids)}::uuid[]) AND held_until <= ${at.toISOString()}`,
          ),
        );
        released += gone.length;
      } catch (error) {
        if (!failed) throw error;
        failed(shopId, error);
      }
    }
    return released;
  }

  /**
   * Gives back what the shop's checkouts `where` says hold, in `tx`, and clears their holds; those
   * it gave back. Locked first, so a hold is given back once.
   */
  async #releaseWhere(
    tx: Tx,
    shopId: string,
    where: SQL,
  ): Promise<{ id: string; held: HeldLineValue[] }[]> {
    const { rows } = await tx.execute<{ id: string; held: HeldLineValue[] }>(sql`
      SELECT id, held FROM checkout.checkouts
       WHERE shop_id = ${shopId} AND held IS NOT NULL AND ${where}
       ORDER BY id
         FOR UPDATE`);
    if (rows.length === 0) return [];
    await tx.execute(sql`
      UPDATE checkout.checkouts SET held = NULL, held_until = NULL
       WHERE shop_id = ${shopId} AND id = ANY(${sql.param(rows.map((row) => row.id))}::uuid[])`);
    for (const row of rows) {
      await this.#stock.releaseReservation(tx, SYSTEM(shopId), row.held, {
        referenceDocumentUri: holdReference(row.id),
      });
    }
    return rows;
  }
}

/** `items` as the stock they take: a bundle's as its parts (ADR-410), merged by variant. */
async function partsOf(
  tx: Tx,
  shopId: string,
  items: readonly { variantId: string; quantity: number }[],
): Promise<{ variantId: string; quantity: number }[]> {
  const bundles = await bundlesOfVariantsIn(
    tx,
    shopId,
    items.map((item) => item.variantId),
  );
  const wanted = new Map<string, number>();
  const add = (variantId: string, quantity: number) =>
    wanted.set(variantId, (wanted.get(variantId) ?? 0) + quantity);
  for (const item of items) {
    const bundle = bundles.get(item.variantId);
    if (!bundle) add(item.variantId, item.quantity);
    else for (const part of bundle.components) add(part.variantId, part.quantity * item.quantity);
  }
  return [...wanted].map(([variantId, quantity]) => ({ variantId, quantity }));
}

/**
 * The units the checkouts of cart `cartId` hold, by variant, in the caller's `tx`: still the
 * shopper's, so their cart counts them as for sale to them. Held past their minutes too, until the
 * sweep gives them back.
 */
export async function heldForCartIn(
  tx: Tx,
  shopId: string,
  cartId: string,
): Promise<Map<string, number>> {
  const { rows } = await tx.execute<{ variant_id: string; quantity: number }>(sql`
    SELECT line."variantId" AS variant_id, sum(line.quantity)::int AS quantity
      FROM checkout.checkouts c,
           jsonb_to_recordset(c.held) AS line("variantId" uuid, quantity int)
     WHERE c.shop_id = ${shopId} AND c.cart_id = ${cartId} AND c.held IS NOT NULL
     GROUP BY line."variantId"`);
  return new Map(rows.map((row) => [row.variant_id, row.quantity]));
}

/**
 * How long the shop's checkouts hold their carts' stock (ADR-715), set through the Admin API.
 */
@Injectable()
export class StockHoldService {
  constructor(private readonly db: Database) {}

  /** The minutes a checkout holds its cart's stock; null for none. */
  get(tenant: TenantContext): Promise<number | null> {
    return this.db.tenant(tenant.shopId, (tx) => holdMinutesIn(tx, tenant.shopId));
  }

  /**
   * Sets the minutes, from 5 to 60, or null to hold none; records `stock_hold.updated` if they
   * changed. Holds already taken keep their minutes.
   */
  async update(
    tenant: TenantContext,
    minutes: number | null,
  ): Promise<MutationResult<number | null>> {
    const check = new InputChecker();
    if (
      minutes !== null &&
      (!Number.isInteger(minutes) ||
        minutes < HOLD_LIMITS.minMinutes ||
        minutes > HOLD_LIMITS.maxMinutes)
    ) {
      check.addMessage(
        ['minutes'],
        'INVALID',
        `Hold stock for ${HOLD_LIMITS.minMinutes} to ${HOLD_LIMITS.maxMinutes} minutes`,
      );
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await holdMinutesIn(tx, tenant.shopId);
      await tx
        .insert(holdSettings)
        .values({ shopId: tenant.shopId, minutes })
        .onConflictDoUpdate({
          target: holdSettings.shopId,
          set: { minutes, updatedAt: sql`now()` },
        });
      if (before !== minutes) {
        await appendEvent<StockHoldUpdatedPayload>(tx, tenant.shopId, {
          type: CheckoutEvents.StockHoldUpdated,
          aggregateType: 'stock_hold',
          aggregateId: tenant.shopId,
          payload: { minutes },
        });
      }
      return { ok: true, value: minutes };
    });
  }
}
