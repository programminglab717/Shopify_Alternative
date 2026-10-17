import {
  InputChecker,
  fail,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { productsAndCollectionsIn } from '@hatti/catalog/public';
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
  /** The catalog's products and collections it is for (ADR-517); empty or null, the whole order. */
  productIds?: readonly string[] | null;
  collectionIds?: readonly string[] | null;
  /** Buy X get Y (ADR-519): items bought for each group, 1 to 100. */
  buyQuantity?: number | null;
  /** Buy X get Y: items given in each group, 1 to 100, `percentage` off them (100 unless given). */
  getQuantity?: number | null;
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
    | 'productIds'
    | 'collectionIds'
    | 'buyQuantity'
    | 'getQuantity'
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
        const missing = await missingItemsIn(tx, tenant.shopId, values);
        if (missing.length > 0) return fail(missing);
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
            buyQuantity: values.buyQuantity ?? null,
            getQuantity: values.getQuantity ?? null,
            minimumSubtotal: values.minimumSubtotal ?? null,
            ...(values.startsAt ? { startsAt: values.startsAt } : {}),
            endsAt: values.endsAt ?? null,
            usageLimit: values.usageLimit ?? null,
            oncePerCustomer: values.oncePerCustomer ?? false,
            productIds: values.productIds ?? [],
            collectionIds: values.collectionIds ?? [],
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
        const missing = await missingItemsIn(tx, tenant.shopId, checked.value);
        if (missing.length > 0) return fail(missing);
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

/** The shop's code of that ID, in the caller's transaction `tx`; null for one deleted. */
export async function discountCodeByIdIn(
  tx: Tx,
  shopId: string,
  id: string,
): Promise<DiscountCodeRecord | null> {
  const [row] = await tx
    .select()
    .from(discountCodes)
    .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.id, id)));
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

  checkOffer(check, tenant, input, current, value, 'code');
  if (input.usageLimit !== undefined) {
    value.usageLimit =
      input.usageLimit === null
        ? null
        : check.integer(['usageLimit'], input.usageLimit, { min: 1, max: USAGE_LIMIT_MAX });
  }
  if (present(input.oncePerCustomer)) value.oncePerCustomer = input.oncePerCustomer;
  return check.ok ? { ok: true, value } : fail(check.errors);
}

/** What a discount gives, with its minimum and dates, as codes and automatic discounts take it. */
export interface OfferInput {
  percentage?: number | null;
  amount?: string | null;
  freeShipping?: boolean | null;
  minimumSubtotal?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  /** The catalog's products and collections it is for (ADR-517); empty or null, the whole order. */
  productIds?: readonly string[] | null;
  collectionIds?: readonly string[] | null;
  /** Buy X get Y (ADR-519): items bought, and items given at `percentage` off, 100 unless given. */
  buyQuantity?: number | null;
  getQuantity?: number | null;
}

/** Buy X get Y counts at most this many items bought, and this many given (ADR-519). */
export const BUY_X_GET_Y_LIMIT = 100;

/** A discount names at most this many products, and this many collections (ADR-517). */
export const DISCOUNT_ITEMS_LIMIT = 100;

/** The columns of what a discount gives that an input sets. */
export interface CheckedOffer {
  kind?: DiscountKindValue;
  percentageBps?: number | null;
  amount?: bigint | null;
  minimumSubtotal?: bigint | null;
  startsAt?: Date;
  endsAt?: Date | null;
  productIds?: string[];
  collectionIds?: string[];
  buyQuantity?: number | null;
  getQuantity?: number | null;
}

/** What a discount is now, which a change is checked over. */
interface CurrentOffer {
  startsAt: Date;
  endsAt: Date | null;
  kind: DiscountKindValue;
  percentageBps: number | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  productIds: string[];
  collectionIds: string[];
}

/**
 * Checks what `input` says a discount gives, its minimum and dates, into `value`: for a new one
 * (`current` null), or over `current`, whose dates the new ones must still fit. `noun` names it in
 * messages: a code, or a discount.
 */
export function checkOffer(
  check: InputChecker,
  tenant: TenantContext,
  input: OfferInput,
  current: CurrentOffer | null,
  value: CheckedOffer,
  noun: 'code' | 'discount',
): void {
  const creating = current === null;
  // Buy X get Y (ADR-519): its quantities say so; a percentage alone changes one's off.
  const buying =
    present(input.buyQuantity) ||
    present(input.getQuantity) ||
    (current?.kind === 'buy_x_get_y' &&
      present(input.percentage) &&
      !present(input.amount) &&
      input.freeShipping !== true);
  if (buying) {
    checkBuyXGetY(check, input, current, value, noun);
    checkRest(check, tenant, input, current, value, noun);
    return;
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
      `A ${noun} gives one thing: a percentage off, an amount off, or free delivery`,
    );
  } else if (given.length === 0 && creating) {
    check.addMessage(
      ['percentage'],
      'BLANK',
      `Say what the ${noun} gives: a percentage off, an amount off, or free delivery`,
    );
  } else if (given[0] === 'percentage') {
    const bps = percentageOf(check, input.percentage!);
    if (bps !== null) Object.assign(value, kindOf('percentage', bps, null));
  } else if (given[0] === 'amount') {
    const amount = check.price(['amount'], input.amount, tenant.currency);
    if (amount === 0n) check.add(['amount'], 'INVALID', 'must be more than zero');
    else if (amount !== null) Object.assign(value, kindOf('fixed_amount', null, amount));
  } else if (given[0] === 'freeShipping') {
    Object.assign(value, kindOf('free_shipping', null, null));
  }
  checkRest(check, tenant, input, current, value, noun);
}

/** Hundredths of a percent from a percentage given, or null and why not. */
function percentageOf(check: InputChecker, percentage: number): number | null {
  const bps = Math.round(percentage * 100);
  if (!(bps >= 1 && bps <= 10_000) || Math.abs(percentage * 100 - bps) > 1e-6) {
    check.addMessage(
      ['percentage'],
      'INVALID',
      'Percentage must be from 0.01 to 100, with two decimals at most, like 10 or 12.5',
    );
    return null;
  }
  return bps;
}

/**
 * Buy X get Y's quantities and how much off the items given (ADR-519): both quantities, kept from
 * one that buys already; the percentage off, free unless given or kept.
 */
function checkBuyXGetY(
  check: InputChecker,
  input: OfferInput,
  current: CurrentOffer | null,
  value: CheckedOffer,
  noun: 'code' | 'discount',
): void {
  if (present(input.amount) || input.freeShipping === true) {
    check.addMessage(
      [present(input.amount) ? 'amount' : 'freeShipping'],
      'INVALID',
      `A ${noun} gives one thing: a percentage off, an amount off, free delivery, or items for others bought`,
    );
    return;
  }
  const kept = current?.kind === 'buy_x_get_y' ? current : null;
  const quantity = (field: 'buyQuantity' | 'getQuantity') => {
    const given = input[field];
    if (present(given)) {
      return check.integer([field], given, { min: 1, max: BUY_X_GET_Y_LIMIT });
    }
    if (kept?.[field]) return kept[field];
    check.add([field], 'BLANK', "can't be blank");
    return null;
  };
  const buy = quantity('buyQuantity');
  const get = quantity('getQuantity');
  const bps = present(input.percentage)
    ? percentageOf(check, input.percentage)
    : (kept?.percentageBps ?? 10_000);
  if (buy === null || get === null || bps === null) return;
  Object.assign(value, {
    kind: 'buy_x_get_y',
    percentageBps: bps,
    amount: null,
    buyQuantity: buy,
    getQuantity: get,
  } satisfies CheckedOffer);
}

/** Its minimum, dates, and the products and collections it is for. */
function checkRest(
  check: InputChecker,
  tenant: TenantContext,
  input: OfferInput,
  current: CurrentOffer | null,
  value: CheckedOffer,
  noun: 'code' | 'discount',
): void {
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

  // The products and collections it is for (ADR-517): free delivery is for the whole order.
  for (const field of ['productIds', 'collectionIds'] as const) {
    const ids = input[field];
    if (ids === undefined) continue;
    const unique = [...new Set(ids ?? [])];
    if (unique.length > DISCOUNT_ITEMS_LIMIT) {
      check.addMessage(
        [field],
        'TOO_MANY',
        `A ${noun} is for at most ${DISCOUNT_ITEMS_LIMIT} ${field === 'productIds' ? 'products' : 'collections'}`,
      );
    } else value[field] = unique;
  }
  if ((value.kind ?? current?.kind) === 'free_shipping') {
    if ((value.productIds?.length ?? 0) > 0 || (value.collectionIds?.length ?? 0) > 0) {
      check.addMessage(
        [(value.productIds?.length ?? 0) > 0 ? 'productIds' : 'collectionIds'],
        'INVALID',
        'Free delivery is for the whole order, not some products or collections',
      );
    } else {
      // Made free delivery: for the whole order, whatever it was for before.
      value.productIds = [];
      value.collectionIds = [];
    }
  }
}

/**
 * Of the products and collections `value` names, those the shop doesn't have, as errors on their
 * place in the input, in the caller's transaction `tx`.
 */
export async function missingItemsIn(
  tx: Tx,
  shopId: string,
  value: Pick<CheckedOffer, 'productIds' | 'collectionIds'>,
): Promise<FieldError[]> {
  const productIds = value.productIds ?? [];
  const collectionIds = value.collectionIds ?? [];
  if (productIds.length === 0 && collectionIds.length === 0) return [];
  const found = await productsAndCollectionsIn(tx, shopId, { productIds, collectionIds });
  return [
    ...productIds.flatMap((id, index) =>
      found.productIds.has(id)
        ? []
        : [
            {
              field: ['productIds', String(index)],
              code: 'NOT_FOUND' as const,
              message: 'Product not found',
            },
          ],
    ),
    ...collectionIds.flatMap((id, index) =>
      found.collectionIds.has(id)
        ? []
        : [
            {
              field: ['collectionIds', String(index)],
              code: 'NOT_FOUND' as const,
              message: 'Collection not found',
            },
          ],
    ),
  ];
}

/** Whether a column's value stays as it is: dates by their time, lists by what they hold. */
export function sameValue(now: unknown, next: unknown): boolean {
  if (now instanceof Date && next instanceof Date) return now.getTime() === next.getTime();
  if (Array.isArray(now) && Array.isArray(next)) {
    return now.length === next.length && now.every((item, index) => item === next[index]);
  }
  return now === next;
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
  return { kind, percentageBps, amount, buyQuantity: null, getQuantity: null };
}

/** Of `checked`, what differs from `row`. */
function changedColumns(row: DiscountCodeRow, checked: CheckedCode): CheckedCode {
  const changes: Record<string, unknown> = {};
  for (const [column, next] of Object.entries(checked) as [keyof CheckedCode, unknown][]) {
    if (!sameValue(row[column], next)) changes[column] = next;
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
    buyQuantity: row.buyQuantity,
    getQuantity: row.getQuantity,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    usageLimit: row.usageLimit,
    oncePerCustomer: row.oncePerCustomer,
    used: row.used,
    productIds: row.productIds,
    collectionIds: row.collectionIds,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
