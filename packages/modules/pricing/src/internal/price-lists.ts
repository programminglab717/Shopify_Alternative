import { variantNamesIn, variantsIn } from '@hatti/catalog/public';
import {
  InputChecker,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, isUniqueViolation, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { PricingEvents, type PriceListChangedPayload } from './events.js';
import {
  priceListPrices,
  priceLists,
  type PriceListRow,
  type QuantityBreakValue,
} from './schema.js';

/** What a shop keeps of its price lists, at most. */
export const PRICE_LIST_LIMITS = {
  perShop: 20,
  name: 100,
  tag: 40,
  /** The most off, in percent, a list or a break takes. */
  percent: 90,
  breaks: 5,
  /** Variants with a price of their own in one list. */
  prices: 2_000,
} as const;

/** A share in percent, to two places: "10", "7.5" or "12.25". */
const PERCENT = /^\d{1,2}(\.\d{1,2})?$/;

/** A shop's wholesale prices, for the customers it gave a tag (CUS-06, ADR-778). */
export interface PriceListRecord {
  id: string;
  name: string;
  /** The customers it is for: those with this tag, in any letter case. */
  customerTag: string;
  /** Off every item without a price of its own, in hundredths of a percent. */
  percentOffBps: number;
  /** More off as more of a variant is bought, the quantities rising. */
  quantityBreaks: QuantityBreakValue[];
  /** How many variants have a price of their own in it. */
  pricedVariants: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PriceListInput {
  name: string;
  customerTag: string;
  /** In percent, to two places: "10" or "7.5"; none for no share off. */
  percentOff?: string | null;
  quantityBreaks?: { minQuantity: number; percentOff: string }[] | null;
}

/** Fields left out stay as they are. */
export interface PriceListUpdateInput {
  name?: string | null;
  customerTag?: string | null;
  percentOff?: string | null;
  quantityBreaks?: { minQuantity: number; percentOff: string }[] | null;
}

/** A variant's price in a list, in minor units, with what the admin names it by (ADR-779). */
export interface PriceListPrice {
  variantId: string;
  price: bigint;
  productTitle: string;
  /** Null for a product's only variant. */
  variantTitle: string | null;
  /** Its price to anyone, minor units. */
  retailPrice: bigint;
}

/** A line to price for a customer: its variant, how many, and its price to anyone. */
export interface LineToPrice {
  variantId: string;
  quantity: number;
  /** Minor units, each. */
  price: bigint;
}

/** What a price list makes a line cost, and which list. */
export interface ListPrice {
  /** Minor units, each; never above the line's own price. */
  price: bigint;
  priceListId: string;
  priceListName: string;
}

const TAKEN = 'Another price list is for customers with this tag';

/** A list's prices, named by their products and variants, by product then variant (ADR-779). */
async function pricesOf(tx: Tx, shopId: string, id: string): Promise<PriceListPrice[]> {
  const rows = await tx
    .select({ variantId: priceListPrices.variantId, price: priceListPrices.price })
    .from(priceListPrices)
    .where(and(eq(priceListPrices.shopId, shopId), eq(priceListPrices.priceListId, id)))
    .orderBy(asc(priceListPrices.variantId));
  const names = await variantNamesIn(
    tx,
    shopId,
    rows.map((row) => row.variantId),
  );
  return rows
    .flatMap((row) => {
      const name = names.get(row.variantId);
      // A variant deleted takes its prices with it; one gone meanwhile is left out.
      return name
        ? [
            {
              ...row,
              productTitle: name.productTitle,
              variantTitle: name.variantTitle,
              retailPrice: name.price,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        a.productTitle.localeCompare(b.productTitle) ||
        (a.variantTitle ?? '').localeCompare(b.variantTitle ?? ''),
    );
}

/**
 * Wholesale price lists (CUS-06, ADR-778): a shop's prices for the customers it tags as
 * wholesale buyers, a share off every item, prices of its own for some variants, and more off as
 * more of a variant is bought. Which customers a list is for is a tag the shop gives them, so a
 * list follows a customer however they order.
 */
@Injectable()
export class PriceListService {
  constructor(private readonly db: Database) {}

  async create(
    tenant: TenantContext,
    input: PriceListInput,
  ): Promise<MutationResult<PriceListRecord>> {
    const check = new InputChecker();
    const name = checkName(check, input.name);
    const customerTag = checkTag(check, input.customerTag);
    const percentOffBps = checkPercent(check, ['input', 'percentOff'], input.percentOff ?? '0');
    const quantityBreaks = checkBreaks(check, input.quantityBreaks ?? []);
    if (!check.ok || !name || !customerTag || percentOffBps === null || !quantityBreaks) {
      return { ok: false, errors: check.errors };
    }
    return this.#unique(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`price_lists:${tenant.shopId}`}, 0))`,
        );
        const [kept] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(priceLists)
          .where(eq(priceLists.shopId, tenant.shopId));
        if (kept!.count >= PRICE_LIST_LIMITS.perShop) {
          return failOne(
            ['input'],
            'TOO_MANY',
            `A shop keeps at most ${PRICE_LIST_LIMITS.perShop} price lists`,
          );
        }
        const [row] = await tx
          .insert(priceLists)
          .values({
            shopId: tenant.shopId,
            id: newId(),
            name,
            customerTag,
            percentOffBps,
            quantityBreaks,
          })
          .returning();
        await changed(tx, tenant.shopId, PricingEvents.PriceListCreated, row!);
        return { ok: true, value: toRecord(row!, 0) };
      }),
    );
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: PriceListUpdateInput,
  ): Promise<MutationResult<PriceListRecord>> {
    const check = new InputChecker();
    const changes: Partial<
      Pick<PriceListRow, 'name' | 'customerTag' | 'percentOffBps' | 'quantityBreaks'>
    > = {};
    if (input.name !== undefined) {
      const name = checkName(check, input.name);
      if (name) changes.name = name;
    }
    if (input.customerTag !== undefined) {
      const tag = checkTag(check, input.customerTag);
      if (tag) changes.customerTag = tag;
    }
    if (input.percentOff !== undefined) {
      const bps = checkPercent(check, ['input', 'percentOff'], input.percentOff ?? '0');
      if (bps !== null) changes.percentOffBps = bps;
    }
    if (input.quantityBreaks !== undefined) {
      const breaks = checkBreaks(check, input.quantityBreaks ?? []);
      if (breaks) changes.quantityBreaks = breaks;
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.#unique(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        const where = and(eq(priceLists.shopId, tenant.shopId), eq(priceLists.id, id));
        const [current] = await tx.select().from(priceLists).where(where).for('update');
        if (!current) return failOne(['input', 'id'], 'NOT_FOUND', 'Price list not found');
        const count = await pricedCount(tx, tenant.shopId, id);
        if (Object.keys(changes).length === 0) return { ok: true, value: toRecord(current, count) };
        const [row] = await tx
          .update(priceLists)
          .set({ ...changes, version: sql`${priceLists.version} + 1`, updatedAt: sql`now()` })
          .where(where)
          .returning();
        await changed(tx, tenant.shopId, PricingEvents.PriceListUpdated, row!);
        return { ok: true, value: toRecord(row!, count) };
      }),
    );
  }

  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .delete(priceLists)
        .where(and(eq(priceLists.shopId, tenant.shopId), eq(priceLists.id, id)))
        .returning();
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Price list not found');
      await changed(tx, tenant.shopId, PricingEvents.PriceListDeleted, row);
      return { ok: true, value: { id } };
    });
  }

  /** The shop's price lists, in the order they were made. */
  async list(tenant: TenantContext): Promise<PriceListRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(priceLists)
        .where(eq(priceLists.shopId, tenant.shopId))
        .orderBy(asc(priceLists.createdAt), asc(priceLists.id));
      const counts = await tx
        .select({ id: priceListPrices.priceListId, count: sql<number>`count(*)::int` })
        .from(priceListPrices)
        .where(eq(priceListPrices.shopId, tenant.shopId))
        .groupBy(priceListPrices.priceListId);
      return rows.map((row) =>
        toRecord(row, counts.find((each) => each.id === row.id)?.count ?? 0),
      );
    });
  }

  /** The variants with a price of their own in a list; null if the shop has no such list. */
  async prices(tenant: TenantContext, id: string): Promise<PriceListPrice[] | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [list] = await tx
        .select({ id: priceLists.id })
        .from(priceLists)
        .where(and(eq(priceLists.shopId, tenant.shopId), eq(priceLists.id, id)));
      if (!list) return null;
      return pricesOf(tx, tenant.shopId, id);
    });
  }

  /**
   * Gives variants prices of their own in a list, or takes them away (a price of null): the
   * prices of the variants not named stay as they are.
   */
  async setPrices(
    tenant: TenantContext,
    id: string,
    prices: readonly { variantId: string; price: string | null }[],
  ): Promise<MutationResult<PriceListPrice[]>> {
    const check = new InputChecker();
    const set: { variantId: string; price: bigint }[] = [];
    const removed: string[] = [];
    const seen = new Set<string>();
    for (const [index, each] of prices.entries()) {
      const field = ['prices', String(index)];
      if (seen.has(each.variantId)) {
        check.addMessage([...field, 'variantId'], 'TAKEN', 'A variant is named once');
        continue;
      }
      seen.add(each.variantId);
      if (each.price === null) {
        removed.push(each.variantId);
        continue;
      }
      const price = check.price([...field, 'price'], each.price, tenant.currency, {
        required: true,
      });
      if (price !== null) set.push({ variantId: each.variantId, price });
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db
      .tenant(tenant.shopId, async (tx): Promise<MutationResult<PriceListPrice[]>> => {
        const where = and(eq(priceLists.shopId, tenant.shopId), eq(priceLists.id, id));
        const [list] = await tx.select().from(priceLists).where(where).for('update');
        if (!list) return failOne(['id'], 'NOT_FOUND', 'Price list not found');
        const known = await variantsIn(
          tx,
          tenant.shopId,
          set.map((each) => each.variantId),
        );
        const errors: FieldError[] = prices.flatMap((each, index) =>
          each.price !== null && !known.has(each.variantId)
            ? [
                {
                  field: ['prices', String(index), 'variantId'],
                  code: 'NOT_FOUND' as const,
                  message: 'Variant not found',
                },
              ]
            : [],
        );
        if (errors.length > 0) return { ok: false, errors };
        if (removed.length > 0) {
          await tx
            .delete(priceListPrices)
            .where(
              and(
                eq(priceListPrices.shopId, tenant.shopId),
                eq(priceListPrices.priceListId, id),
                inArray(priceListPrices.variantId, removed),
              ),
            );
        }
        if (set.length > 0) {
          await tx
            .insert(priceListPrices)
            .values(set.map((each) => ({ shopId: tenant.shopId, priceListId: id, ...each })))
            .onConflictDoUpdate({
              target: [
                priceListPrices.shopId,
                priceListPrices.priceListId,
                priceListPrices.variantId,
              ],
              set: { price: sql`excluded.price` },
            });
        }
        if ((await pricedCount(tx, tenant.shopId, id)) > PRICE_LIST_LIMITS.prices) {
          // Thrown back, so the transaction keeps the list as it was.
          throw new PriceListFullError();
        }
        const [row] = await tx
          .update(priceLists)
          .set({ version: sql`${priceLists.version} + 1`, updatedAt: sql`now()` })
          .where(where)
          .returning();
        await changed(tx, tenant.shopId, PricingEvents.PriceListUpdated, row!);
        return { ok: true, value: await pricesOf(tx, tenant.shopId, id) };
      })
      .catch((error: unknown) => {
        if (error instanceof PriceListFullError) {
          return failOne<PriceListPrice[]>(
            ['prices'],
            'TOO_MANY',
            `A price list gives at most ${PRICE_LIST_LIMITS.prices} variants a price of their own`,
          );
        }
        throw error;
      });
  }

  /** A tag another list is for is refused, whichever transaction gets there first. */
  async #unique(
    write: () => Promise<MutationResult<PriceListRecord>>,
  ): Promise<MutationResult<PriceListRecord>> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error, 'price_lists_tag_one')) {
        return failOne(['input', 'customerTag'], 'TAKEN', TAKEN);
      }
      throw error;
    }
  }
}

class PriceListFullError extends Error {}

/**
 * What the shop's price lists make `lines` cost a customer with `tags` (ADR-778), each line in
 * its place: null where no list of theirs makes it cost less than its own price. A line's list
 * price is the variant's price in the list, or else its own price less the list's share off;
 * less again the largest quantity break the line's quantity reaches. Where the customer has more
 * than one list, the lowest price of theirs wins.
 */
export async function listPricesIn(
  tx: Tx,
  shopId: string,
  tags: readonly string[],
  lines: readonly LineToPrice[],
): Promise<(ListPrice | null)[]> {
  const folded = [...new Set(tags.map((tag) => tag.trim().toLowerCase()))].filter(Boolean);
  if (folded.length === 0 || lines.length === 0) return lines.map(() => null);
  const lists = await tx
    .select()
    .from(priceLists)
    .where(
      and(
        eq(priceLists.shopId, shopId),
        sql`lower(${priceLists.customerTag}) = ANY(${sql.param(folded)}::text[])`,
      ),
    );
  if (lists.length === 0) return lines.map(() => null);
  const own = await tx
    .select()
    .from(priceListPrices)
    .where(
      and(
        eq(priceListPrices.shopId, shopId),
        inArray(
          priceListPrices.priceListId,
          lists.map((list) => list.id),
        ),
        inArray(priceListPrices.variantId, [...new Set(lines.map((line) => line.variantId))]),
      ),
    );
  return lines.map((line) => {
    let best: ListPrice | null = null;
    for (const list of lists) {
      const fixed = own.find(
        (each) => each.priceListId === list.id && each.variantId === line.variantId,
      )?.price;
      const base = fixed ?? less(line.price, list.percentOffBps);
      const reached = list.quantityBreaks
        .filter((each) => line.quantity >= each.minQuantity)
        .reduce((most, each) => Math.max(most, each.percentOffBps), 0);
      const price = less(base, reached);
      if (price < line.price && (!best || price < best.price)) {
        best = { price, priceListId: list.id, priceListName: list.name };
      }
    }
    return best;
  });
}

/** `amount` less `bps` hundredths of a percent, rounded down to the paisa. */
function less(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

function toRecord(row: PriceListRow, pricedVariants: number): PriceListRecord {
  return {
    id: row.id,
    name: row.name,
    customerTag: row.customerTag,
    percentOffBps: row.percentOffBps,
    quantityBreaks: row.quantityBreaks,
    pricedVariants,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function pricedCount(tx: Tx, shopId: string, id: string): Promise<number> {
  const [counted] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(priceListPrices)
    .where(and(eq(priceListPrices.shopId, shopId), eq(priceListPrices.priceListId, id)));
  return counted!.count;
}

async function changed(tx: Tx, shopId: string, type: string, row: PriceListRow): Promise<void> {
  await appendEvent<PriceListChangedPayload>(tx, shopId, {
    type,
    aggregateType: 'price_list',
    aggregateId: row.id,
    payload: { name: row.name, customerTag: row.customerTag, version: row.version },
  });
}

function checkName(check: InputChecker, name: string | null | undefined): string | null {
  return check.text(['input', 'name'], name, { required: true, max: PRICE_LIST_LIMITS.name });
}

function checkTag(check: InputChecker, tag: string | null | undefined): string | null {
  return check.text(['input', 'customerTag'], tag, { required: true, max: PRICE_LIST_LIMITS.tag });
}

/** A share in percent, to two places, as hundredths of a percent: 0 to the limit. */
function checkPercent(
  check: InputChecker,
  field: string[],
  value: string | null | undefined,
): number | null {
  const text = value?.trim() || '0';
  const [whole = '0', part = ''] = text.split('.');
  const bps = PERCENT.test(text) ? Number(whole) * 100 + Number(part.padEnd(2, '0')) : -1;
  if (bps < 0 || bps > PRICE_LIST_LIMITS.percent * 100) {
    check.addMessage(
      field,
      'INVALID',
      `A share off is 0% to ${PRICE_LIST_LIMITS.percent}%, to two places`,
    );
    return null;
  }
  return bps;
}

/** Quantity breaks: at most five, each from 2 units up and more than 0% off, quantities rising. */
function checkBreaks(
  check: InputChecker,
  breaks: readonly { minQuantity: number; percentOff: string }[],
): QuantityBreakValue[] | null {
  if (breaks.length > PRICE_LIST_LIMITS.breaks) {
    check.addMessage(
      ['input', 'quantityBreaks'],
      'TOO_MANY',
      `A price list has at most ${PRICE_LIST_LIMITS.breaks} quantity breaks`,
    );
    return null;
  }
  const checked: QuantityBreakValue[] = [];
  for (const [index, each] of breaks.entries()) {
    const field = ['input', 'quantityBreaks', String(index)];
    const minQuantity = check.integer([...field, 'minQuantity'], each.minQuantity, {
      min: 2,
      max: 100_000,
    });
    const bps = checkPercent(check, [...field, 'percentOff'], each.percentOff);
    if (minQuantity === null || bps === null) continue;
    if (bps === 0) {
      check.addMessage([...field, 'percentOff'], 'INVALID', 'A quantity break takes something off');
      continue;
    }
    const before = checked.at(-1);
    if (before && minQuantity <= before.minQuantity) {
      check.addMessage(
        [...field, 'minQuantity'],
        'INVALID',
        'Quantity breaks go from the fewest units to the most',
      );
      continue;
    }
    checked.push({ minQuantity, percentOffBps: bps });
  }
  return check.ok ? checked : null;
}
