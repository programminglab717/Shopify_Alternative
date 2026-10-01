import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, isUniqueViolation, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { DISCOUNT_CODE, DISCOUNT_CODE_LIMIT } from './discounts.js';
import { PricingEvents, type DiscountCodeChangedPayload } from './events.js';
import type { DiscountCodeRecord, Page } from './records.js';
import { discountCodes, type DiscountCodeRow, type DiscountKindValue } from './schema.js';

/**
 * A discount code, or what changes of one. Left out, a field stays as it is; null clears one that
 * may be empty. One of `percentage`, `amount` and `freeShipping` says what the code gives, and
 * giving another changes it.
 */
export interface DiscountCodeInput {
  code?: string | null;
  /** What staff call it; the code itself when not given. */
  title?: string | null;
  /** Percent off the order's items: 0.01 to 100. */
  percentage?: number | null;
  /** An amount off the order's items, in major units: "500". */
  amount?: string | null;
  freeShipping?: boolean | null;
  /** What the order's items must come to, in major units. */
  minimumSubtotal?: string | null;
  /** From when it works; now when not given. */
  startsAt?: Date | null;
  /** Until when; null for no end. */
  endsAt?: Date | null;
  /** Orders that may be placed with it, in all. */
  usageLimit?: number | null;
  oncePerCustomer?: boolean | null;
}

/** The most uses a code may be given. */
const USAGE_LIMIT_MAX = 1_000_000;

/** The columns an input sets. */
type CheckedCode = Partial<
  Pick<
    DiscountCodeRow,
    | 'code'
    | 'title'
    | 'kind'
    | 'percentageBps'
    | 'amount'
    | 'minimumSubtotal'
    | 'startsAt'
    | 'endsAt'
    | 'usageLimit'
    | 'oncePerCustomer'
  >
>;

/**
 * A shop's discount codes (CHK-06, ADR-062), as Shopify's basic and free-shipping codes are: a
 * percentage or an amount off an order's items, or free delivery, with a minimum, dates, a limit
 * on uses and one use a customer if the shop wants. Codes are matched ignoring case, so a shop
 * cannot have EID25 and eid25.
 */
@Injectable()
export class DiscountCodeService {
  constructor(private readonly db: Database) {}

  /** The shop's codes, newest first; with `query`, those whose code or title has it. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null; query?: string | null },
  ): Promise<Page<DiscountCodeRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const conditions: SQL[] = [eq(discountCodes.shopId, tenant.shopId)];
      if (options.after) conditions.push(lt(discountCodes.id, options.after));
      // No code or title has control characters, and Postgres refuses some.
      const query = options.query?.replace(/\p{Cc}/gu, '').trim();
      if (query) {
        const like = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        conditions.push(or(ilike(discountCodes.code, like), ilike(discountCodes.title, like))!);
      }
      const rows = await tx
        .select()
        .from(discountCodes)
        .where(and(...conditions))
        .orderBy(desc(discountCodes.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<DiscountCodeRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(discountCodes)
        .where(and(eq(discountCodes.shopId, tenant.shopId), eq(discountCodes.id, id)));
      return row ? toRecord(row) : null;
    });
  }

  /** The code the shop has by that name, in any letter case. */
  async byCode(tenant: TenantContext, code: string): Promise<DiscountCodeRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => discountCodeIn(tx, tenant.shopId, code));
  }

  /** A new code. Records `discount_code.created`. */
  async create(
    tenant: TenantContext,
    input: DiscountCodeInput,
  ): Promise<MutationResult<DiscountCodeRecord>> {
    const checked = checkCode(tenant, input, null);
    if (!checked.ok) return checked;
    const values = checked.value;
    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const [counts] = await tx
          .select({ total: count() })
          .from(discountCodes)
          .where(eq(discountCodes.shopId, tenant.shopId));
        if ((counts?.total ?? 0) >= DISCOUNT_CODE_LIMIT) {
          return failOne(
            [],
            'TOO_MANY',
            `A shop can keep at most ${DISCOUNT_CODE_LIMIT.toLocaleString('en')} discount codes`,
          );
        }
        const [row] = await tx
          .insert(discountCodes)
          .values({
            shopId: tenant.shopId,
            id: newId(),
            code: values.code!,
            title: values.title ?? values.code!,
            kind: values.kind!,
            percentageBps: values.percentageBps ?? null,
            amount: values.amount ?? null,
            minimumSubtotal: values.minimumSubtotal ?? null,
            ...(values.startsAt ? { startsAt: values.startsAt } : {}),
            endsAt: values.endsAt ?? null,
            usageLimit: values.usageLimit ?? null,
            oncePerCustomer: values.oncePerCustomer ?? false,
          })
          .returning();
        await recordEvent(tx, PricingEvents.DiscountCodeCreated, row!);
        return { ok: true, value: toRecord(row!) };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'discount_codes_code_key')) return taken(values.code!);
      throw error;
    }
  }

  /** Changes what is given of the code; the rest stays. Records `discount_code.updated`. */
  async update(
    tenant: TenantContext,
    id: string,
    input: DiscountCodeInput,
  ): Promise<MutationResult<DiscountCodeRecord>> {
    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const [row] = await tx
          .select()
          .from(discountCodes)
          .where(and(eq(discountCodes.shopId, tenant.shopId), eq(discountCodes.id, id)))
          .for('update');
        if (!row) return failOne(['id'], 'NOT_FOUND', 'Discount code not found');
        const checked = checkCode(tenant, input, row);
        if (!checked.ok) return checked;
        const changes = changedColumns(row, checked.value);
        if (Object.keys(changes).length === 0) return { ok: true, value: toRecord(row) };
        const [updated] = await tx
          .update(discountCodes)
          .set({ ...changes, version: sql`${discountCodes.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(discountCodes.shopId, tenant.shopId), eq(discountCodes.id, id)))
          .returning();
        await recordEvent(tx, PricingEvents.DiscountCodeUpdated, updated!);
        return { ok: true, value: toRecord(updated!) };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'discount_codes_code_key')) return taken(input.code ?? '');
      throw error;
    }
  }

  /**
   * Deletes the code: shoppers can no longer use it, and orders placed with it keep it. Records
   * `discount_code.deleted`.
   */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .delete(discountCodes)
        .where(and(eq(discountCodes.shopId, tenant.shopId), eq(discountCodes.id, id)))
        .returning();
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Discount code not found');
      await recordEvent(tx, PricingEvents.DiscountCodeDeleted, row);
      return { ok: true, value: { id } };
    });
  }
}

/** The shop's code by that name, in any letter case, in the caller's transaction `tx`. */
export async function discountCodeIn(
  tx: Tx,
  shopId: string,
  code: string,
): Promise<DiscountCodeRecord | null> {
  const [row] = await tx
    .select()
    .from(discountCodes)
    .where(
      and(
        eq(discountCodes.shopId, shopId),
        sql`lower(${discountCodes.code}) = lower(${code.trim()})`,
      ),
    );
  return row ? toRecord(row) : null;
}

function taken(code: string): MutationResult<DiscountCodeRecord> {
  return failOne(
    ['code'],
    'TAKEN',
    `The shop has a code ${code.trim()} already, in some letter case`,
  );
}

/**
 * The columns `input` sets, checked: for a new code (`current` null), or over `current`, whose
 * dates the new ones must still fit.
 */
function checkCode(
  tenant: TenantContext,
  input: DiscountCodeInput,
  current: DiscountCodeRow | null,
): MutationResult<CheckedCode> {
  const check = new InputChecker();
  const value: CheckedCode = {};
  const creating = current === null;

  if (input.code !== undefined || creating) {
    const code = input.code?.trim() ?? '';
    if (code === '') check.add(['code'], 'BLANK', "can't be blank");
    else if (!DISCOUNT_CODE.test(code)) {
      check.addMessage(
        ['code'],
        'INVALID',
        'A code is letters, digits, hyphens and underscores, up to 64, like EID25 or SAVE-500',
      );
    } else value.code = code;
  }
  if (input.title !== undefined) {
    const title = check.text(['title'], input.title, { max: 255 });
    if (title !== null) value.title = title;
    // Cleared: the code names it again.
    else if (current) value.title = value.code ?? current.code;
  }

  const given = [
    present(input.percentage) && 'percentage',
    present(input.amount) && 'amount',
    input.freeShipping === true && 'freeShipping',
  ].filter((name): name is string => name !== false);
  if (given.length > 1) {
    check.addMessage(
      [given[1]!],
      'INVALID',
      'A code gives one thing: a percentage off, an amount off, or free delivery',
    );
  } else if (given.length === 0 && creating) {
    check.addMessage(
      ['percentage'],
      'BLANK',
      'Say what the code gives: a percentage off, an amount off, or free delivery',
    );
  } else if (given[0] === 'percentage') {
    const bps = Math.round(input.percentage! * 100);
    if (!(bps >= 1 && bps <= 10_000) || Math.abs(input.percentage! * 100 - bps) > 1e-6) {
      check.addMessage(
        ['percentage'],
        'INVALID',
        'Percentage must be from 0.01 to 100, with two decimals at most, like 10 or 12.5',
      );
    } else Object.assign(value, kindOf('percentage', bps, null));
  } else if (given[0] === 'amount') {
    const amount = check.price(['amount'], input.amount, tenant.currency);
    if (amount === 0n) check.add(['amount'], 'INVALID', 'must be more than zero');
    else if (amount !== null) Object.assign(value, kindOf('fixed_amount', null, amount));
  } else if (given[0] === 'freeShipping') {
    Object.assign(value, kindOf('free_shipping', null, null));
  }

  if (input.minimumSubtotal !== undefined) {
    const minimum = check.price(['minimumSubtotal'], input.minimumSubtotal, tenant.currency);
    if (minimum === 0n) check.add(['minimumSubtotal'], 'INVALID', 'must be more than zero');
    else value.minimumSubtotal = minimum;
  }
  if (present(input.startsAt)) value.startsAt = input.startsAt;
  if (input.endsAt !== undefined) value.endsAt = input.endsAt;
  const startsAt = value.startsAt ?? current?.startsAt ?? new Date();
  const endsAt = value.endsAt !== undefined ? value.endsAt : (current?.endsAt ?? null);
  if (endsAt !== null && endsAt <= startsAt) {
    check.addMessage(['endsAt'], 'INVALID', 'Ends at must be later than starts at');
  }
  if (input.usageLimit !== undefined) {
    value.usageLimit =
      input.usageLimit === null
        ? null
        : check.integer(['usageLimit'], input.usageLimit, { min: 1, max: USAGE_LIMIT_MAX });
  }
  if (present(input.oncePerCustomer)) value.oncePerCustomer = input.oncePerCustomer;
  return check.ok ? { ok: true, value } : fail(check.errors);
}

/** Given, and not null. */
function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function kindOf(
  kind: DiscountKindValue,
  percentageBps: number | null,
  amount: bigint | null,
): CheckedCode {
  return { kind, percentageBps, amount };
}

/** Of `checked`, what differs from `row`. */
function changedColumns(row: DiscountCodeRow, checked: CheckedCode): CheckedCode {
  const changes: Record<string, unknown> = {};
  for (const [column, next] of Object.entries(checked) as [keyof CheckedCode, unknown][]) {
    const now = row[column];
    const same =
      now instanceof Date && next instanceof Date ? now.getTime() === next.getTime() : now === next;
    if (!same) changes[column] = next;
  }
  return changes as CheckedCode;
}

async function recordEvent(tx: Tx, type: string, row: DiscountCodeRow): Promise<void> {
  await appendEvent<DiscountCodeChangedPayload>(tx, row.shopId, {
    type,
    aggregateType: 'discount_code',
    aggregateId: row.id,
    payload: { code: row.code, kind: row.kind, version: row.version },
  });
}

export function toRecord(row: DiscountCodeRow): DiscountCodeRecord {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    kind: row.kind,
    percentageBps: row.percentageBps,
    amount: row.amount,
    minimumSubtotal: row.minimumSubtotal,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    usageLimit: row.usageLimit,
    oncePerCustomer: row.oncePerCustomer,
    used: row.used,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
