import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Selling plans (CAT-16, ADR-862): how a shop sells its products by subscription, as Shopify's
// selling plans are: "Every month, 10% off", for its products of a tag, or all of them. A cart
// line subscribed says so as its hidden `_selling_plan` property, the plan's public ID, and is
// priced at the plan's discount; the order it becomes keeps the property, and the orders module
// makes the subscription of it.

export const SellingPlanEvents = {
  /** A plan was made, changed or deleted: the storefront's shop document lists them. */
  Updated: 'selling_plan.updated',
} as const;

/** The hidden property a subscribed cart line names its plan in. */
export const SELLING_PLAN_PROPERTY = '_selling_plan';

export const SELLING_PLAN_LIMITS = {
  perShop: 10,
  name: 60,
  tag: 255,
  intervalCount: { min: 1, max: 12 },
  discountPercent: { min: 0, max: 50 },
} as const;

export type SellingPlanInterval = 'week' | 'month';

export interface SellingPlanRecord {
  id: string;
  name: string;
  intervalUnit: SellingPlanInterval;
  intervalCount: number;
  discountPercent: number;
  /** The tag of the products it is for; null for all of them. */
  productTag: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SellingPlanInput {
  name: string;
  intervalUnit: string;
  intervalCount: number;
  discountPercent: number;
  productTag?: string | null;
}

type PlanRow = {
  id: string;
  name: string;
  interval_unit: SellingPlanInterval;
  interval_count: number;
  discount_percent: number;
  product_tag: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const toRecord = (row: PlanRow): SellingPlanRecord => ({
  id: row.id,
  name: row.name,
  intervalUnit: row.interval_unit,
  intervalCount: row.interval_count,
  discountPercent: row.discount_percent,
  productTag: row.product_tag,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
});

const COLUMNS = sql.raw(
  'id, name, interval_unit, interval_count, discount_percent, product_tag, created_at, updated_at',
);

/** A unit's price on the plan: `price` less its discount, to the nearest minor unit. */
export function planPrice(price: bigint, discountPercent: number): bigint {
  return price - (price * BigInt(discountPercent) + 50n) / 100n;
}

/** The plan a line's properties name, of those its product is sold on; null for none. */
export function planOfLine<T extends { id: string }>(
  plans: readonly T[] | undefined,
  properties: Readonly<Record<string, string>>,
): T | null {
  const named = properties[SELLING_PLAN_PROPERTY];
  if (!named || !plans) return null;
  const id = tryFromPublicId(named, 'sellingPlan');
  return plans.find((plan) => plan.id === id) ?? null;
}

/** The shop's plans, in the order made, in the caller's transaction `tx`. */
export async function sellingPlansIn(tx: Tx, shopId: string): Promise<SellingPlanRecord[]> {
  const { rows } = await tx.execute<PlanRow>(sql`
    SELECT ${COLUMNS} FROM catalog.selling_plans WHERE shop_id = ${shopId} ORDER BY created_at, id`);
  return rows.map(toRecord);
}

/**
 * The plans each of `productIds` is sold on, in the caller's transaction `tx`: those for all the
 * shop's products, and those for a tag it has, ignoring case. A product on none is not in the map.
 */
export async function sellingPlansForIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, SellingPlanRecord[]>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await tx.execute<PlanRow & { product_id: string }>(sql`
    SELECT p.id AS product_id, s.id, s.name, s.interval_unit, s.interval_count,
           s.discount_percent, s.product_tag, s.created_at, s.updated_at
      FROM catalog.products p
      JOIN catalog.selling_plans s ON s.shop_id = p.shop_id
     WHERE p.shop_id = ${shopId} AND p.id = ANY (${sql.param([...productIds])}::uuid[])
       AND (s.product_tag IS NULL
            OR EXISTS (SELECT 1 FROM unnest(p.tags) tag WHERE lower(tag) = lower(s.product_tag)))
     ORDER BY s.created_at, s.id`);
  const plans = new Map<string, SellingPlanRecord[]>();
  for (const row of rows) {
    plans.set(row.product_id, [...(plans.get(row.product_id) ?? []), toRecord(row)]);
  }
  return plans;
}

/** The public ID a line's property names a plan by. */
export function sellingPlanPropertyOf(planId: string): string {
  return toPublicId('sellingPlan', planId);
}

const NOT_FOUND = 'No selling plan of the shop has this ID';

/**
 * The shop's selling plans (ADR-862), kept by staff who write products: ten at most. Each change
 * is an event the storefront's publisher hears, as its pages offer the plans.
 */
@Injectable()
export class SellingPlanService {
  constructor(private readonly db: Database) {}

  async list(tenant: TenantContext): Promise<SellingPlanRecord[]> {
    return this.db.tenant(tenant.shopId, (tx) => sellingPlansIn(tx, tenant.shopId));
  }

  async create(
    tenant: TenantContext,
    input: SellingPlanInput,
  ): Promise<MutationResult<SellingPlanRecord>> {
    const checked = checkInput(input);
    if (!checked.ok) return checked;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: counted } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM catalog.selling_plans WHERE shop_id = ${tenant.shopId}`);
      if (counted[0]!.count >= SELLING_PLAN_LIMITS.perShop) {
        return failOne<SellingPlanRecord>(
          ['input', 'name'],
          'TOO_MANY',
          `A shop keeps ${SELLING_PLAN_LIMITS.perShop} selling plans at most`,
        );
      }
      const plan = checked.value;
      const { rows } = await tx.execute<PlanRow>(sql`
        INSERT INTO catalog.selling_plans
               (shop_id, name, interval_unit, interval_count, discount_percent, product_tag)
        VALUES (${tenant.shopId}, ${plan.name}, ${plan.intervalUnit}, ${plan.intervalCount},
                ${plan.discountPercent}, ${plan.productTag})
        RETURNING ${COLUMNS}`);
      const record = toRecord(rows[0]!);
      await this.#changed(tx, tenant, record, 'selling_plan.created');
      return { ok: true, value: record };
    });
  }

  /** Changes a plan: subscriptions made already keep the plan as it was. */
  async update(
    tenant: TenantContext,
    id: string,
    input: SellingPlanInput,
  ): Promise<MutationResult<SellingPlanRecord>> {
    const checked = checkInput(input);
    if (!checked.ok) return checked;
    const plan = checked.value;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<PlanRow>(sql`
        UPDATE catalog.selling_plans
           SET name = ${plan.name}, interval_unit = ${plan.intervalUnit},
               interval_count = ${plan.intervalCount}, discount_percent = ${plan.discountPercent},
               product_tag = ${plan.productTag}, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING ${COLUMNS}`);
      if (!rows[0]) return failOne<SellingPlanRecord>(['id'], 'NOT_FOUND', NOT_FOUND);
      const record = toRecord(rows[0]);
      await this.#changed(tx, tenant, record, 'selling_plan.updated');
      return { ok: true, value: record };
    });
  }

  /** Deletes a plan: products are no longer offered it; subscriptions made keep going. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<string>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<PlanRow>(sql`
        DELETE FROM catalog.selling_plans WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING ${COLUMNS}`);
      if (!rows[0]) return failOne<string>(['id'], 'NOT_FOUND', NOT_FOUND);
      await this.#changed(tx, tenant, toRecord(rows[0]), 'selling_plan.deleted');
      return { ok: true, value: id };
    });
  }

  async #changed(
    tx: Tx,
    tenant: TenantContext,
    record: SellingPlanRecord,
    action: string,
  ): Promise<void> {
    await appendEvent(tx, tenant.shopId, {
      type: SellingPlanEvents.Updated,
      aggregateType: 'selling_plan',
      aggregateId: record.id,
      payload: {},
    });
    await recordAudit(tx, tenant.shopId, {
      action,
      subjectType: 'sellingPlan',
      subjectId: record.id,
      ...actorColumnsOf(tenant.actor),
      details: { name: record.name, discountPercent: record.discountPercent },
    });
  }
}

function checkInput(input: SellingPlanInput): MutationResult<
  Omit<SellingPlanInput, 'intervalUnit'> & {
    intervalUnit: SellingPlanInterval;
    productTag: string | null;
  }
> {
  const check = new InputChecker();
  const name = check.text(['input', 'name'], input.name, {
    required: true,
    max: SELLING_PLAN_LIMITS.name,
  });
  if (input.intervalUnit !== 'week' && input.intervalUnit !== 'month') {
    check.add(['input', 'intervalUnit'], 'INVALID', 'must be WEEK or MONTH');
  }
  const intervalCount = check.integer(
    ['input', 'intervalCount'],
    input.intervalCount,
    SELLING_PLAN_LIMITS.intervalCount,
  );
  const discountPercent = check.integer(
    ['input', 'discountPercent'],
    input.discountPercent,
    SELLING_PLAN_LIMITS.discountPercent,
  );
  const productTag = check.text(['input', 'productTag'], input.productTag, {
    max: SELLING_PLAN_LIMITS.tag,
  });
  if (!check.ok) return { ok: false, errors: check.errors };
  return {
    ok: true,
    value: {
      name: name!,
      intervalUnit: input.intervalUnit as SellingPlanInterval,
      intervalCount: intervalCount!,
      discountPercent: discountPercent!,
      productTag,
    },
  };
}
