import {
  failOne,
  shopProfile,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { exponentOf, type CurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { loadProducts, productChanged } from './product-store.js';
import type { ProductRecord } from './records.js';

/** Events of sales set ahead. Payloads are thin: fetch current state through the API. */
export const PriceSaleEvents = {
  Created: 'price_sale.created',
  /** It started, ended or was cancelled: `state` says which. */
  Updated: 'price_sale.updated',
} as const;

export interface PriceSaleUpdatedPayload {
  state: PriceSaleState;
}

/** How big a sale may be, and how far ahead (CAT-17, ADR-443). */
export const PRICE_SALE_LIMITS = {
  name: 100,
  products: 250,
  percentOff: { min: 1, max: 90 },
  /** How far ahead it may start. */
  aheadDays: 365,
  /** How long it may last. */
  longestDays: 90,
  /** A start this near now, or before it, starts it at once. */
  nowWithinMs: 60_000,
  /** The newest kept in the list. */
  listed: 100,
} as const;

const DAY_MS = 86_400_000;

export type PriceSaleState = 'scheduled' | 'running' | 'ended' | 'cancelled';

export interface PriceSaleRecord {
  id: string;
  name: string;
  percentOff: number;
  startsAt: Date;
  endsAt: Date;
  state: PriceSaleState;
  /** When it ended, at its time or cancelled while it ran; null until then. */
  endedAt: Date | null;
  productIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PriceSaleInput {
  name: string;
  percentOff: number;
  startsAt: Date;
  endsAt: Date;
  productIds: readonly string[];
}

type SaleRow = {
  id: string;
  name: string;
  percent_off: number;
  starts_at: string | Date;
  ends_at: string | Date;
  state: PriceSaleState;
  ended_at: string | Date | null;
  product_ids: string[] | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const COLUMNS = sql.raw(
  's.id, s.name, s.percent_off, s.starts_at, s.ends_at, s.state, s.ended_at, s.created_at, ' +
    's.updated_at, (SELECT array_agg(sp.product_id ORDER BY sp.product_id) ' +
    '  FROM catalog.price_sale_products sp ' +
    '  WHERE sp.shop_id = s.shop_id AND sp.sale_id = s.id) AS product_ids',
);

function toRecord(row: SaleRow): PriceSaleRecord {
  return {
    id: row.id,
    name: row.name,
    percentOff: Number(row.percent_off),
    startsAt: toDate(row.starts_at),
    endsAt: toDate(row.ends_at),
    state: row.state,
    endedAt: toDateOrNull(row.ended_at),
    productIds: row.product_ids ?? [],
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/** A price cut by `percent`, down to a whole unit of the currency, as an offer's is (ADR-438). */
export function salePrice(price: bigint, percent: number, currency: CurrencyCode): bigint {
  const unit = 10n ** BigInt(exponentOf(currency));
  const cut = (price * BigInt(100 - percent)) / 100n;
  return cut - (cut % unit);
}

type Shop = Pick<TenantContext, 'shopId' | 'currency'>;

/**
 * Sales set ahead (CAT-17, ADR-443): a percentage off the shop's chosen products from a time to a
 * time. When one starts, each variant's price is cut to a whole rupee and its old price shown as
 * its compare-at price; when it ends, both come back, unless the shop changed the price by hand
 * meanwhile. A product is in one sale at a time.
 */
@Injectable()
export class PriceSaleService {
  constructor(private readonly db: Database) {}

  /** The shop's sales, those starting latest first; the newest hundred. */
  async list(tenant: TenantContext): Promise<PriceSaleRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<SaleRow>(sql`
        SELECT ${COLUMNS} FROM catalog.price_sales s
         WHERE s.shop_id = ${tenant.shopId}
         ORDER BY s.starts_at DESC, s.id DESC
         LIMIT ${PRICE_SALE_LIMITS.listed}`),
    );
    return rows.map(toRecord);
  }

  async get(tenant: TenantContext, id: string): Promise<PriceSaleRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => this.#load(tx, tenant.shopId, id));
  }

  /** The products of each of `saleIds`, as records; those deleted since are gone. */
  async productsOf(
    tenant: TenantContext,
    saleIds: readonly string[],
  ): Promise<Map<string, ProductRecord[]>> {
    if (saleIds.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ sale_id: string; product_id: string }>(sql`
        SELECT sale_id, product_id FROM catalog.price_sale_products
         WHERE shop_id = ${tenant.shopId} AND sale_id = ANY(${sql.param([...saleIds])}::uuid[])`);
      const ids = [...new Set(rows.map((row) => row.product_id))];
      const records =
        ids.length === 0
          ? []
          : await loadProducts(tx, tenant.shopId, {
              where: sql`p.id = ANY(${sql.param(ids)}::uuid[])`,
            });
      const byId = new Map(records.map((record) => [record.id, record]));
      const products = new Map<string, ProductRecord[]>();
      for (const row of rows) {
        const record = byId.get(row.product_id);
        if (record) products.set(row.sale_id, [...(products.get(row.sale_id) ?? []), record]);
      }
      for (const list of products.values()) list.sort((a, b) => a.title.localeCompare(b.title));
      return products;
    });
  }

  /**
   * Sets a sale ahead: `percentOff` its products from `startsAt` to `endsAt`. One starting now, or
   * a minute from now at most, starts at once; others when the worker's sweep comes to them.
   */
  async create(
    tenant: TenantContext,
    input: PriceSaleInput,
  ): Promise<MutationResult<PriceSaleRecord>> {
    const errors: FieldError[] = [];
    const add = (field: string[], code: FieldError['code'], message: string) =>
      errors.push({ field, code, message });
    const name = input.name.trim();
    if (name.length === 0) add(['name'], 'BLANK', "can't be blank");
    else if (name.length > PRICE_SALE_LIMITS.name) {
      add(['name'], 'TOO_LONG', `must be ${PRICE_SALE_LIMITS.name} characters at most`);
    }
    const { min, max } = PRICE_SALE_LIMITS.percentOff;
    if (!Number.isInteger(input.percentOff) || input.percentOff < min || input.percentOff > max) {
      add(['percentOff'], 'INVALID', `must be a whole number from ${min} to ${max}`);
    }
    const now = Date.now();
    const starts = input.startsAt.getTime();
    const ends = input.endsAt.getTime();
    if (Number.isNaN(starts) || starts < now - PRICE_SALE_LIMITS.nowWithinMs) {
      add(['startsAt'], 'INVALID', 'Give a time from now on');
    } else if (starts > now + PRICE_SALE_LIMITS.aheadDays * DAY_MS) {
      add(['startsAt'], 'INVALID', 'Give a time within a year');
    }
    if (Number.isNaN(ends) || !(ends > starts)) {
      add(['endsAt'], 'INVALID', 'Give a time after it starts');
    } else if (ends - starts > PRICE_SALE_LIMITS.longestDays * DAY_MS) {
      add(['endsAt'], 'INVALID', `A sale lasts ${PRICE_SALE_LIMITS.longestDays} days at most`);
    }
    if (input.productIds.length === 0) add(['productIds'], 'BLANK', 'Choose a product at least');
    if (input.productIds.length > PRICE_SALE_LIMITS.products) {
      add(
        ['productIds'],
        'TOO_MANY',
        `A sale takes ${PRICE_SALE_LIMITS.products} products at most`,
      );
    }
    const seen = new Set<string>();
    input.productIds.forEach((id, index) => {
      if (seen.has(id))
        add(['productIds', String(index)], 'TAKEN', 'This product is named already');
      seen.add(id);
    });
    if (errors.length > 0) return { ok: false, errors };

    const startNow = starts <= now + PRICE_SALE_LIMITS.nowWithinMs;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const shopId = tenant.shopId;
      const ids = [...input.productIds];
      // Locked, so two sales set at once can't both take a product for the same days.
      const { rows: found } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM catalog.products
         WHERE shop_id = ${shopId} AND id = ANY(${sql.param(ids)}::uuid[])
         ORDER BY id FOR UPDATE`);
      const known = new Set(found.map((row) => row.id));
      const { rows: clashes } = await tx.execute<{ product_id: string; name: string }>(sql`
        SELECT sp.product_id, s.name FROM catalog.price_sale_products sp
          JOIN catalog.price_sales s ON s.shop_id = sp.shop_id AND s.id = sp.sale_id
         WHERE sp.shop_id = ${shopId} AND sp.product_id = ANY(${sql.param(ids)}::uuid[])
           AND s.state IN ('scheduled', 'running')
           AND s.starts_at < ${input.endsAt.toISOString()}::timestamptz
           AND s.ends_at > ${input.startsAt.toISOString()}::timestamptz`);
      const clashing = new Map(clashes.map((row) => [row.product_id, row.name]));
      ids.forEach((id, index) => {
        const field = ['productIds', String(index)];
        if (!known.has(id)) add(field, 'NOT_FOUND', 'No product of the shop has this ID');
        else if (clashing.has(id)) {
          add(field, 'TAKEN', `It is in the sale "${clashing.get(id)}" for some of these days`);
        }
      });
      if (errors.length > 0) return { ok: false, errors };

      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO catalog.price_sales (shop_id, name, percent_off, starts_at, ends_at)
        VALUES (${shopId}, ${name}, ${input.percentOff},
                ${input.startsAt.toISOString()}::timestamptz,
                ${input.endsAt.toISOString()}::timestamptz)
        RETURNING id`);
      const id = rows[0]!.id;
      await tx.execute(sql`
        INSERT INTO catalog.price_sale_products (shop_id, sale_id, product_id)
        SELECT ${shopId}, ${id}, unnest(${sql.param(ids)}::uuid[])`);
      await appendEvent(tx, shopId, {
        type: PriceSaleEvents.Created,
        aggregateType: 'price_sale',
        aggregateId: id,
        payload: {},
      });
      if (startNow) await this.#start(tx, tenant, id);
      return { ok: true, value: (await this.#load(tx, shopId, id))! };
    });
  }

  /**
   * Cancels a sale not yet started, or ends one running now, its prices put back. One ended or
   * cancelled already is refused.
   */
  async cancel(tenant: TenantContext, id: string): Promise<MutationResult<PriceSaleRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ state: PriceSaleState }>(sql`
        SELECT state FROM catalog.price_sales
         WHERE shop_id = ${tenant.shopId} AND id = ${id} FOR UPDATE`);
      const state = rows[0]?.state;
      if (!state) return failOne(['id'], 'NOT_FOUND', 'No sale of the shop has this ID');
      if (state === 'scheduled') {
        await tx.execute(sql`
          UPDATE catalog.price_sales SET state = 'cancelled', updated_at = now()
           WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
        await this.#recorded(tx, tenant.shopId, id, 'cancelled');
      } else if (state === 'running') {
        await this.#end(tx, tenant, id);
      } else {
        return failOne(['id'], 'INVALID', 'The sale is over already');
      }
      return { ok: true, value: (await this.#load(tx, tenant.shopId, id))! };
    });
  }

  /** The shops with sales whose time to start or end came, found with the system role. */
  async shopsWithSalesDue(): Promise<string[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT shop_id FROM catalog.price_sales WHERE state = 'scheduled' AND starts_at <= now()
        UNION
        SELECT shop_id FROM catalog.price_sales WHERE state = 'running' AND ends_at <= now()`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * Ends the shop's sales whose time came, then starts those whose time came, each in its own
   * transaction: a product in a sale ending as another starts goes from one to the other. How
   * many started or ended.
   */
  async runDue(shopId: string): Promise<number> {
    const due = await this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string; state: PriceSaleState }>(sql`
        SELECT id, state FROM catalog.price_sales
         WHERE shop_id = ${shopId}
           AND ((state = 'running' AND ends_at <= now())
             OR (state = 'scheduled' AND starts_at <= now()))
         ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, starts_at, id`);
      const currency = (await shopProfile(tx, shopId)).currency as CurrencyCode;
      return { rows, currency };
    });
    const shop: Shop = { shopId, currency: due.currency as TenantContext['currency'] };
    let done = 0;
    for (const sale of due.rows) {
      const changed = await this.db.tenant(shopId, async (tx) => {
        const { rows } = await tx.execute<{ state: PriceSaleState; due: boolean }>(sql`
          SELECT state, CASE state WHEN 'running' THEN ends_at <= now()
                                   ELSE starts_at <= now() END AS due
            FROM catalog.price_sales WHERE shop_id = ${shopId} AND id = ${sale.id} FOR UPDATE`);
        const current = rows[0];
        if (!current?.due || current.state !== sale.state) return false;
        if (current.state === 'running') await this.#end(tx, shop, sale.id);
        else await this.#start(tx, shop, sale.id);
        return true;
      });
      if (changed) done += 1;
    }
    return done;
  }

  /** Starts a sale: each variant of its products cut, its prices before kept to put back. */
  async #start(tx: Tx, shop: Shop, id: string): Promise<void> {
    const { rows: sale } = await tx.execute<{ percent_off: number }>(sql`
      UPDATE catalog.price_sales SET state = 'running', updated_at = now()
       WHERE shop_id = ${shop.shopId} AND id = ${id} AND state = 'scheduled'
       RETURNING percent_off`);
    if (!sale[0]) return;
    const percent = Number(sale[0].percent_off);
    const { rows: variants } = await tx.execute<{
      id: string;
      product_id: string;
      price: string;
      compare_at_price: string | null;
    }>(sql`
      SELECT v.id, v.product_id, v.price, v.compare_at_price FROM catalog.variants v
        JOIN catalog.price_sale_products sp
          ON sp.shop_id = v.shop_id AND sp.product_id = v.product_id
       WHERE sp.shop_id = ${shop.shopId} AND sp.sale_id = ${id}
       ORDER BY v.id FOR UPDATE OF v`);
    const cuts = variants.flatMap((variant) => {
      const price = BigInt(variant.price);
      const cut = salePrice(price, percent, shop.currency as CurrencyCode);
      // Too cheap to cut by a whole unit: left at its price.
      return cut > 0n && cut < price ? [{ ...variant, cut }] : [];
    });
    if (cuts.length > 0) {
      const values = cuts.map(
        (each) =>
          sql`(${each.id}::uuid, ${each.price}::bigint, ${each.compare_at_price}::bigint, ${each.cut.toString()}::bigint)`,
      );
      await tx.execute(sql`
        INSERT INTO catalog.price_sale_variants
               (shop_id, sale_id, variant_id, price, compare_at_price, sale_price)
        SELECT ${shop.shopId}, ${id}, u.id, u.price, u.compare_at, u.cut
          FROM (VALUES ${sql.join(values, sql`, `)}) AS u(id, price, compare_at, cut)`);
      // The price before shown struck through; a higher compare-at price is kept.
      await tx.execute(sql`
        UPDATE catalog.variants v
           SET price = s.sale_price,
               compare_at_price = GREATEST(coalesce(s.compare_at_price, 0), s.price),
               updated_at = now()
          FROM catalog.price_sale_variants s
         WHERE s.shop_id = ${shop.shopId} AND s.sale_id = ${id}
           AND v.shop_id = s.shop_id AND v.id = s.variant_id`);
    }
    for (const productId of [...new Set(cuts.map((each) => each.product_id))].sort()) {
      await productChanged(tx, shop, productId, ['variants']);
    }
    await this.#recorded(tx, shop.shopId, id, 'running');
  }

  /** Ends a running sale: each variant's prices put back, unless its price changed since. */
  async #end(tx: Tx, shop: Shop, id: string): Promise<void> {
    await tx.execute(sql`
      UPDATE catalog.price_sales SET state = 'ended', ended_at = now(), updated_at = now()
       WHERE shop_id = ${shop.shopId} AND id = ${id} AND state = 'running'`);
    const { rows } = await tx.execute<{ product_id: string }>(sql`
      UPDATE catalog.variants v
         SET price = s.price, compare_at_price = s.compare_at_price, updated_at = now()
        FROM catalog.price_sale_variants s
       WHERE s.shop_id = ${shop.shopId} AND s.sale_id = ${id}
         AND v.shop_id = s.shop_id AND v.id = s.variant_id AND v.price = s.sale_price
      RETURNING v.product_id`);
    for (const productId of [...new Set(rows.map((row) => row.product_id))].sort()) {
      await productChanged(tx, shop, productId, ['variants']);
    }
    await this.#recorded(tx, shop.shopId, id, 'ended');
  }

  async #recorded(tx: Tx, shopId: string, id: string, state: PriceSaleState): Promise<void> {
    await appendEvent<PriceSaleUpdatedPayload>(tx, shopId, {
      type: PriceSaleEvents.Updated,
      aggregateType: 'price_sale',
      aggregateId: id,
      payload: { state },
    });
  }

  async #load(tx: Tx, shopId: string, id: string): Promise<PriceSaleRecord | null> {
    const { rows } = await tx.execute<SaleRow>(sql`
      SELECT ${COLUMNS} FROM catalog.price_sales s WHERE s.shop_id = ${shopId} AND s.id = ${id}`);
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
