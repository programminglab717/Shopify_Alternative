import {
  PlanAllowance,
  actorColumnsOf,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

// Drops (INV-09, OS-17, ADR-820): products a shop puts on sale together at a time, such as a
// lawn collection at midnight, until an end. Until it starts its products sell to no one, and its
// drafts go on sale at its start as products scheduled to are (ADR-441). While it is live, each
// customer, by their number, buys so many units of each of its products at most.

/** Events of the shop's drops. */
export const DropEvents = {
  /** A drop was made, changed or deleted: its products' pages say so. */
  Updated: 'drop.updated',
} as const;

/** The products a drop's change touches: those in it before and after. */
export interface DropUpdatedPayload {
  productIds: string[];
}

export const DROP_LIMITS = {
  name: 80,
  products: 250,
  /** The longest a drop lasts. */
  days: 7,
  /** How far ahead one is scheduled. */
  aheadDays: 365,
  perCustomer: { min: 1, max: 100 },
  admitPerMinute: { min: 10, max: 100_000 },
} as const;

export type DropStatus = 'scheduled' | 'live' | 'ended';

export interface DropInput {
  name: string;
  startsAt: Date;
  endsAt: Date;
  productIds: readonly string[];
  /** Units of each product a customer may buy while it is live; null for no limit. */
  perCustomer?: number | null;
  /** Shoppers its waiting room lets in a minute; null for none (ADR-822). */
  admitPerMinute?: number | null;
}

export interface DropProduct {
  id: string;
  title: string;
  status: string;
}

export interface DropRecord {
  id: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  perCustomer: number | null;
  admitPerMinute: number | null;
  products: DropProduct[];
  createdAt: Date;
  updatedAt: Date;
}

/** Whether a drop is still to start, live, or over, at `at`. */
export function dropStatus(drop: Pick<DropRecord, 'startsAt' | 'endsAt'>, at: Date): DropStatus {
  if (at < drop.startsAt) return 'scheduled';
  return at < drop.endsAt ? 'live' : 'ended';
}

/** What a cart or checkout is told of a product's drop that has not ended. */
export interface DropFact {
  dropId: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  perCustomer: number | null;
}

type DropRow = {
  id: string;
  name: string;
  starts_at: string | Date;
  ends_at: string | Date;
  per_customer: number | null;
  admit_per_minute: number | null;
  created_at: string | Date;
  updated_at: string | Date;
  products: DropProduct[];
};

async function dropsWhere(tx: Tx, shopId: string, where: SQL): Promise<DropRecord[]> {
  const { rows } = await tx.execute<DropRow>(sql`
    SELECT d.id, d.name, d.starts_at, d.ends_at, d.per_customer, d.admit_per_minute,
           d.created_at, d.updated_at,
           coalesce((SELECT json_agg(json_build_object('id', p.id, 'title', p.title,
                                                       'status', p.status)
                                     ORDER BY p.title, p.id)
                       FROM catalog.drop_products dp
                       JOIN catalog.products p ON p.shop_id = dp.shop_id AND p.id = dp.product_id
                      WHERE dp.shop_id = d.shop_id AND dp.drop_id = d.id), '[]') AS products
      FROM catalog.drops d
     WHERE d.shop_id = ${shopId} AND ${where}
     ORDER BY d.starts_at DESC, d.id`);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    perCustomer: row.per_customer,
    admitPerMinute: row.admit_per_minute,
    products: row.products,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }));
}

/**
 * The drop each of `productIds` is in that has not ended at `at`, in the caller's transaction: a
 * product in none has none in the map.
 */
export async function dropFactsIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
  at: Date = new Date(),
): Promise<Map<string, DropFact>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    product_id: string;
    id: string;
    name: string;
    starts_at: string | Date;
    ends_at: string | Date;
    per_customer: number | null;
  }>(sql`
    SELECT DISTINCT ON (dp.product_id)
           dp.product_id, d.id, d.name, d.starts_at, d.ends_at, d.per_customer
      FROM catalog.drop_products dp
      JOIN catalog.drops d ON d.shop_id = dp.shop_id AND d.id = dp.drop_id
     WHERE dp.shop_id = ${shopId}
       AND dp.product_id = ANY(${sql.param([...productIds])}::uuid[])
       AND d.ends_at > ${at.toISOString()}
     ORDER BY dp.product_id, d.starts_at`);
  return new Map(
    rows.map((row) => [
      row.product_id,
      {
        dropId: row.id,
        name: row.name,
        startsAt: new Date(row.starts_at),
        endsAt: new Date(row.ends_at),
        perCustomer: row.per_customer,
      },
    ]),
  );
}

/** The shop's drops with a waiting room that have not ended at `at` (ADR-822), the soonest first. */
export async function waitingRoomsIn(
  tx: Tx,
  shopId: string,
  at: Date = new Date(),
): Promise<
  { dropId: string; name: string; startsAt: Date; endsAt: Date; admitPerMinute: number }[]
> {
  const { rows } = await tx.execute<{
    id: string;
    name: string;
    starts_at: string | Date;
    ends_at: string | Date;
    admit_per_minute: number;
  }>(sql`
    SELECT id, name, starts_at, ends_at, admit_per_minute FROM catalog.drops
     WHERE shop_id = ${shopId} AND admit_per_minute IS NOT NULL AND ends_at > ${at.toISOString()}
     ORDER BY starts_at, id`);
  return rows.map((row) => ({
    dropId: row.id,
    name: row.name,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    admitPerMinute: row.admit_per_minute,
  }));
}

/**
 * The shop's drops (ADR-820): scheduled, changed and deleted through the Admin API, on the plans
 * that have them.
 */
@Injectable()
export class DropService {
  constructor(
    private readonly db: Database,
    @Optional() @Inject(PlanAllowance) private readonly allowance: PlanAllowance | null = null,
  ) {}

  /** The shop's drops, the latest to start first. */
  async list(tenant: TenantContext): Promise<DropRecord[]> {
    return this.db.tenant(tenant.shopId, (tx) => dropsWhere(tx, tenant.shopId, sql`true`));
  }

  async get(tenant: TenantContext, id: string): Promise<DropRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [drop] = await dropsWhere(tx, tenant.shopId, sql`d.id = ${id}`);
      return drop ?? null;
    });
  }

  /**
   * Schedules a drop of `input`, or, given `id`, changes that drop to it while it has not ended:
   * its start a minute to a year ahead, unless it has started already and keeps it; its end after
   * its start, a week at most; 1 to 250 products, none a gift card, none in another drop that has
   * not ended. Its drafts go on sale at its start; those it no longer has, or had at another
   * start, go on sale at none.
   */
  async set(
    tenant: TenantContext,
    id: string | null,
    input: DropInput,
    at: Date = new Date(),
  ): Promise<MutationResult<DropRecord>> {
    const { shopId } = tenant;
    const plan = await this.allowance?.excludes(shopId, 'drops');
    if (plan) {
      return failOne(
        ['input'],
        'PROHIBITED',
        `The ${plan} plan doesn't include drops: choose the Pro plan to schedule one`,
      );
    }
    const errors: FieldError[] = [];
    const name = input.name.trim();
    if (name.length < 1 || name.length > DROP_LIMITS.name) {
      errors.push({
        field: ['input', 'name'],
        code: 'INVALID',
        message: `Give the drop a name, up to ${DROP_LIMITS.name} characters`,
      });
    }
    const span = input.endsAt.getTime() - input.startsAt.getTime();
    if (span <= 0 || span > DROP_LIMITS.days * 86_400_000) {
      errors.push({
        field: ['input', 'endsAt'],
        code: 'INVALID',
        message: `A drop ends after it starts, ${DROP_LIMITS.days} days later at most`,
      });
    }
    if (input.startsAt.getTime() > at.getTime() + DROP_LIMITS.aheadDays * 86_400_000) {
      errors.push({
        field: ['input', 'startsAt'],
        code: 'INVALID',
        message: 'Give a start within a year',
      });
    }
    const productIds = [...new Set(input.productIds)];
    if (productIds.length < 1 || productIds.length > DROP_LIMITS.products) {
      errors.push({
        field: ['input', 'productIds'],
        code: productIds.length > DROP_LIMITS.products ? 'TOO_MANY' : 'BLANK',
        message: `A drop has 1 to ${DROP_LIMITS.products} products`,
      });
    }
    const perCustomer = input.perCustomer ?? null;
    const { min, max } = DROP_LIMITS.perCustomer;
    if (
      perCustomer !== null &&
      (!Number.isInteger(perCustomer) || perCustomer < min || perCustomer > max)
    ) {
      errors.push({
        field: ['input', 'perCustomer'],
        code: 'INVALID',
        message: `must be a whole number from ${min} to ${max}`,
      });
    }
    const admitPerMinute = input.admitPerMinute ?? null;
    const rate = DROP_LIMITS.admitPerMinute;
    if (
      admitPerMinute !== null &&
      (!Number.isInteger(admitPerMinute) || admitPerMinute < rate.min || admitPerMinute > rate.max)
    ) {
      errors.push({
        field: ['input', 'admitPerMinute'],
        code: 'INVALID',
        message: `must be a whole number from ${rate.min} to ${rate.max.toLocaleString('en')}`,
      });
    }
    if (errors.length > 0) return { ok: false, errors };

    return this.db.tenant(shopId, async (tx) => {
      // One drop changed at a time in a shop, so that two can't take the same product.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('drops:' || ${shopId}))`);
      let before: { productIds: string[]; startsAt: Date } | null = null;
      if (id) {
        const [current] = await dropsWhere(tx, shopId, sql`d.id = ${id}`);
        if (!current) return failOne(['id'], 'NOT_FOUND', 'Drop not found');
        if (dropStatus(current, at) === 'ended') {
          return failOne(['id'], 'INVALID', 'This drop has ended: schedule another');
        }
        before = {
          productIds: current.products.map((product) => product.id),
          startsAt: current.startsAt,
        };
        // A drop that has started keeps its start.
        if (current.startsAt <= at && input.startsAt.getTime() !== current.startsAt.getTime()) {
          return failOne(
            ['input', 'startsAt'],
            'INVALID',
            'This drop has started: its start stays',
          );
        }
      }
      // One still to start starts a minute ahead at least.
      const started = before !== null && before.startsAt <= at;
      if (!started && input.startsAt.getTime() < at.getTime() + 60_000) {
        return failOne(['input', 'startsAt'], 'INVALID', 'Give a start a minute ahead at least');
      }
      const asked = sql.param(productIds);
      const { rows: found } = await tx.execute<{ id: string; gift_card: boolean }>(sql`
        SELECT id, gift_card FROM catalog.products
         WHERE shop_id = ${shopId} AND id = ANY(${asked}::uuid[])
           FOR UPDATE`);
      const known = new Map(found.map((row) => [row.id, row.gift_card]));
      const { rows: taken } = await tx.execute<{ product_id: string }>(sql`
        SELECT dp.product_id
          FROM catalog.drop_products dp
          JOIN catalog.drops d ON d.shop_id = dp.shop_id AND d.id = dp.drop_id
         WHERE dp.shop_id = ${shopId} AND dp.product_id = ANY(${asked}::uuid[])
           AND d.ends_at > ${at.toISOString()}
           AND d.id IS DISTINCT FROM ${id}::uuid`);
      const elsewhere = new Set(taken.map((row) => row.product_id));
      productIds.forEach((productId, index) => {
        const field = ['input', 'productIds', String(index)];
        const giftCard = known.get(productId);
        if (giftCard === undefined) {
          errors.push({ field, code: 'NOT_FOUND', message: 'No product of the shop has this ID' });
        } else if (giftCard) {
          errors.push({ field, code: 'INVALID', message: 'A gift card is sold in no drop' });
        } else if (elsewhere.has(productId)) {
          errors.push({ field, code: 'TAKEN', message: 'This product is in another drop' });
        }
      });
      if (errors.length > 0) return { ok: false, errors };

      const values = {
        name,
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
      };
      let dropId = id;
      if (dropId) {
        await tx.execute(sql`
          UPDATE catalog.drops
             SET name = ${values.name}, starts_at = ${values.startsAt}, ends_at = ${values.endsAt},
                 per_customer = ${perCustomer}, admit_per_minute = ${admitPerMinute},
                 updated_at = now()
           WHERE shop_id = ${shopId} AND id = ${dropId}`);
        await tx.execute(sql`
          DELETE FROM catalog.drop_products WHERE shop_id = ${shopId} AND drop_id = ${dropId}`);
      } else {
        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO catalog.drops (shop_id, name, starts_at, ends_at, per_customer,
                                     admit_per_minute)
          VALUES (${shopId}, ${values.name}, ${values.startsAt}, ${values.endsAt}, ${perCustomer},
                  ${admitPerMinute})
          RETURNING id`);
        dropId = rows[0]!.id;
      }
      await tx.execute(sql`
        INSERT INTO catalog.drop_products (shop_id, drop_id, product_id)
        SELECT ${shopId}, ${dropId}, unnest(${asked}::uuid[])`);
      if (before) {
        // Drafts it scheduled that it no longer has, or at its old start, go on sale at none.
        await unscheduleIn(tx, shopId, before.productIds, before.startsAt);
      }
      // Its drafts go on sale at its start, if it is still ahead (ADR-441).
      if (input.startsAt > at) {
        await tx.execute(sql`
          UPDATE catalog.products SET publish_at = ${values.startsAt}, updated_at = now()
           WHERE shop_id = ${shopId} AND id = ANY(${asked}::uuid[]) AND status = 'draft'`);
      }
      await appendEvent<DropUpdatedPayload>(tx, shopId, {
        type: DropEvents.Updated,
        aggregateType: 'drop',
        aggregateId: dropId,
        payload: { productIds: [...new Set([...(before?.productIds ?? []), ...productIds])] },
      });
      await recordAudit(tx, shopId, {
        action: id ? 'drop.updated' : 'drop.created',
        subjectType: 'drop',
        subjectId: dropId,
        ...actorColumnsOf(tenant.actor),
        details: { ...values, products: productIds.length, perCustomer, admitPerMinute },
      });
      const [drop] = await dropsWhere(tx, shopId, sql`d.id = ${dropId}`);
      return { ok: true, value: drop! };
    });
  }

  /**
   * Deletes a drop: its products sell as any others, and its drafts go on sale at no time. Whether
   * there was one to delete.
   */
  async delete(tenant: TenantContext, id: string): Promise<boolean> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const [drop] = await dropsWhere(tx, shopId, sql`d.id = ${id}`);
      if (!drop) return false;
      await tx.execute(sql`DELETE FROM catalog.drops WHERE shop_id = ${shopId} AND id = ${id}`);
      const productIds = drop.products.map((product) => product.id);
      await unscheduleIn(tx, shopId, productIds, drop.startsAt);
      await appendEvent<DropUpdatedPayload>(tx, shopId, {
        type: DropEvents.Updated,
        aggregateType: 'drop',
        aggregateId: id,
        payload: { productIds },
      });
      await recordAudit(tx, shopId, {
        action: 'drop.deleted',
        subjectType: 'drop',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: { name: drop.name },
      });
      return true;
    });
  }
}

/** Drafts of `productIds` set to go on sale at `startsAt`, as a drop set them, go on sale at none. */
async function unscheduleIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
  startsAt: Date,
): Promise<void> {
  if (productIds.length === 0) return;
  await tx.execute(sql`
    UPDATE catalog.products SET publish_at = NULL, updated_at = now()
     WHERE shop_id = ${shopId} AND id = ANY(${sql.param([...productIds])}::uuid[])
       AND status = 'draft' AND publish_at = ${startsAt.toISOString()}`);
}
