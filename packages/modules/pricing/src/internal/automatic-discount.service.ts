import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import {
  checkOffer,
  missingItemsIn,
  sameValue,
  type CheckedOffer,
  type OfferInput,
} from './discount-code.service.js';
import { PricingEvents, type AutomaticDiscountChangedPayload } from './events.js';
import type { AutomaticDiscountRecord } from './records.js';
import { automaticDiscounts, type AutomaticDiscountRow } from './schema.js';

/** A shop keeps at most this many automatic discounts, running, ahead or ended. */
export const AUTOMATIC_DISCOUNT_LIMIT = 25;

/**
 * An automatic discount, or what changes of one. Left out, a field stays as it is; null clears one
 * that may be empty. One of `percentage`, `amount` and `freeShipping` says what it gives.
 */
export interface AutomaticDiscountInput extends OfferInput {
  /** What shoppers see beside what it takes off: "Eid sale". */
  title?: string | null;
  combinesWithCodes?: boolean | null;
}

type CheckedAutomatic = CheckedOffer & { title?: string; combinesWithCodes?: boolean };

/**
 * A shop's automatic discounts (CHK-06, ADR-515), as Shopify's are: a percentage or an amount off
 * an order's items, or free delivery, with a minimum and dates, taken without a code by every cart
 * and checkout that qualifies.
 */
@Injectable()
export class AutomaticDiscountService {
  constructor(private readonly db: Database) {}

  /** The shop's automatic discounts, newest first. */
  async list(tenant: TenantContext): Promise<AutomaticDiscountRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(automaticDiscounts)
        .where(eq(automaticDiscounts.shopId, tenant.shopId))
        .orderBy(desc(automaticDiscounts.createdAt), desc(automaticDiscounts.id));
      return rows.map(toAutomaticRecord);
    });
  }

  async get(tenant: TenantContext, id: string): Promise<AutomaticDiscountRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(automaticDiscounts)
        .where(and(eq(automaticDiscounts.shopId, tenant.shopId), eq(automaticDiscounts.id, id)));
      return row ? toAutomaticRecord(row) : null;
    });
  }

  /** A new automatic discount. Records `automatic_discount.created`. */
  async create(
    tenant: TenantContext,
    input: AutomaticDiscountInput,
  ): Promise<MutationResult<AutomaticDiscountRecord>> {
    const checked = checkAutomatic(tenant, input, null);
    if (!checked.ok) return checked;
    const values = checked.value;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [counts] = await tx
        .select({ total: count() })
        .from(automaticDiscounts)
        .where(eq(automaticDiscounts.shopId, tenant.shopId));
      if ((counts?.total ?? 0) >= AUTOMATIC_DISCOUNT_LIMIT) {
        return failOne(
          [],
          'TOO_MANY',
          `A shop can keep at most ${AUTOMATIC_DISCOUNT_LIMIT} automatic discounts; delete one that ended first`,
        );
      }
      const missing = await missingItemsIn(tx, tenant.shopId, values);
      if (missing.length > 0) return fail(missing);
      const [row] = await tx
        .insert(automaticDiscounts)
        .values({
          shopId: tenant.shopId,
          id: newId(),
          title: values.title!,
          kind: values.kind!,
          percentageBps: values.percentageBps ?? null,
          amount: values.amount ?? null,
          minimumSubtotal: values.minimumSubtotal ?? null,
          ...(values.startsAt ? { startsAt: values.startsAt } : {}),
          endsAt: values.endsAt ?? null,
          combinesWithCodes: values.combinesWithCodes ?? false,
          productIds: values.productIds ?? [],
          collectionIds: values.collectionIds ?? [],
        })
        .returning();
      await recordEvent(tx, PricingEvents.AutomaticDiscountCreated, row!);
      return { ok: true, value: toAutomaticRecord(row!) };
    });
  }

  /** Changes what is given of it; the rest stays. Records `automatic_discount.updated`. */
  async update(
    tenant: TenantContext,
    id: string,
    input: AutomaticDiscountInput,
  ): Promise<MutationResult<AutomaticDiscountRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(automaticDiscounts)
        .where(and(eq(automaticDiscounts.shopId, tenant.shopId), eq(automaticDiscounts.id, id)))
        .for('update');
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Automatic discount not found');
      const checked = checkAutomatic(tenant, input, row);
      if (!checked.ok) return checked;
      const missing = await missingItemsIn(tx, tenant.shopId, checked.value);
      if (missing.length > 0) return fail(missing);
      const changes = changedColumns(row, checked.value);
      if (Object.keys(changes).length === 0) return { ok: true, value: toAutomaticRecord(row) };
      const [updated] = await tx
        .update(automaticDiscounts)
        .set({ ...changes, version: sql`${automaticDiscounts.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(automaticDiscounts.shopId, tenant.shopId), eq(automaticDiscounts.id, id)))
        .returning();
      await recordEvent(tx, PricingEvents.AutomaticDiscountUpdated, updated!);
      return { ok: true, value: toAutomaticRecord(updated!) };
    });
  }

  /**
   * Deletes it: carts and checkouts no longer take it, and orders placed with it keep its title.
   * Records `automatic_discount.deleted`.
   */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .delete(automaticDiscounts)
        .where(and(eq(automaticDiscounts.shopId, tenant.shopId), eq(automaticDiscounts.id, id)))
        .returning();
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Automatic discount not found');
      await recordEvent(tx, PricingEvents.AutomaticDiscountDeleted, row);
      return { ok: true, value: { id } };
    });
  }
}

/**
 * The shop's automatic discounts that run at `at`, oldest first, in the caller's transaction
 * `tx`: those carts and checkouts choose from (ADR-515).
 */
export async function runningAutomaticDiscountsIn(
  tx: Tx,
  shopId: string,
  at: Date = new Date(),
): Promise<AutomaticDiscountRecord[]> {
  const rows = await tx
    .select()
    .from(automaticDiscounts)
    .where(
      and(
        eq(automaticDiscounts.shopId, shopId),
        sql`${automaticDiscounts.startsAt} <= ${at}`,
        sql`(${automaticDiscounts.endsAt} IS NULL OR ${automaticDiscounts.endsAt} > ${at})`,
      ),
    )
    .orderBy(asc(automaticDiscounts.createdAt), asc(automaticDiscounts.id));
  return rows.map(toAutomaticRecord);
}

function checkAutomatic(
  tenant: TenantContext,
  input: AutomaticDiscountInput,
  current: AutomaticDiscountRow | null,
): MutationResult<CheckedAutomatic> {
  const check = new InputChecker();
  const value: CheckedAutomatic = {};
  if (input.title !== undefined || current === null) {
    const title = check.text(['title'], input.title, { required: true, max: 255 });
    if (title !== null) value.title = title;
  }
  checkOffer(check, tenant, input, current, value, 'discount');
  if (input.combinesWithCodes !== undefined && input.combinesWithCodes !== null) {
    value.combinesWithCodes = input.combinesWithCodes;
  }
  return check.ok ? { ok: true, value } : fail(check.errors);
}

/** Of `checked`, what differs from `row`. */
function changedColumns(row: AutomaticDiscountRow, checked: CheckedAutomatic): CheckedAutomatic {
  const changes: Record<string, unknown> = {};
  for (const [column, next] of Object.entries(checked) as [keyof CheckedAutomatic, unknown][]) {
    if (!sameValue(row[column], next)) changes[column] = next;
  }
  return changes as CheckedAutomatic;
}

async function recordEvent(tx: Tx, type: string, row: AutomaticDiscountRow): Promise<void> {
  await appendEvent<AutomaticDiscountChangedPayload>(tx, row.shopId, {
    type,
    aggregateType: 'automatic_discount',
    aggregateId: row.id,
    payload: { title: row.title, kind: row.kind, version: row.version },
  });
}

export function toAutomaticRecord(row: AutomaticDiscountRow): AutomaticDiscountRecord {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    percentageBps: row.percentageBps,
    amount: row.amount,
    minimumSubtotal: row.minimumSubtotal,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    combinesWithCodes: row.combinesWithCodes,
    productIds: row.productIds,
    collectionIds: row.collectionIds,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
