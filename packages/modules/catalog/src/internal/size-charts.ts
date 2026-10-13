import {
  InputChecker,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, isUniqueViolation, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/** Events of size charts. Payloads are thin: fetch current state through the API. */
export const SizeChartEvents = {
  Created: 'size_chart.created',
  /** Its name, unit, measurements or note changed. */
  Updated: 'size_chart.updated',
  Deleted: 'size_chart.deleted',
  /** Products were given a chart, or had theirs taken away. */
  ProductsUpdated: 'product_size_chart.updated',
} as const;

/** A size chart changed, or products' charts did: the products whose pages show another now. */
export interface SizeChartChangedPayload {
  productIds: string[];
}

/** How big a chart may be, and how many a shop keeps. */
export const SIZE_CHART_LIMITS = {
  charts: 50,
  name: 100,
  columns: 8,
  column: 40,
  rows: 30,
  size: 20,
  note: 1_000,
  /** The largest measurement, in either unit. */
  value: 999,
  /** How many products one call gives a chart, by their IDs. */
  products: 250,
} as const;

export type SizeChartUnitValue = 'in' | 'cm';

/** A size and its measurements, one for each of its chart's columns; null where none is given. */
export interface SizeChartRow {
  size: string;
  values: (number | null)[];
}

/** A chart as a product's page shows it. */
export interface ShownSizeChart {
  name: string;
  unit: SizeChartUnitValue;
  columns: string[];
  rows: SizeChartRow[];
  note: string | null;
}

export interface SizeChartRecord extends ShownSizeChart {
  id: string;
  /** How many products show it. */
  productCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What a chart is made of; what an update leaves out stays as it is. */
export interface SizeChartInput {
  name?: string | null;
  unit?: SizeChartUnitValue | null;
  columns?: readonly string[] | null;
  rows?: readonly { size: string; values: readonly (number | null)[] }[] | null;
  note?: string | null;
}

type ChartRow = {
  id: string;
  name: string;
  unit: SizeChartUnitValue;
  columns: string[];
  rows: SizeChartRow[];
  note: string | null;
  product_count: number | string;
  created_at: string | Date;
  updated_at: string | Date;
};

const COLUMNS = sql.raw(
  'c.id, c.name, c.unit, c.columns, c.rows, c.note, c.created_at, c.updated_at, ' +
    '(SELECT count(*) FROM catalog.product_size_charts pc ' +
    '  WHERE pc.shop_id = c.shop_id AND pc.size_chart_id = c.id) AS product_count',
);

function toRecord(row: ChartRow): SizeChartRecord {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    columns: row.columns,
    rows: row.rows,
    note: row.note,
    productCount: Number(row.product_count),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/** A measurement as kept: more than nothing and at most 999, to a hundredth. */
function measurement(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0 || value > SIZE_CHART_LIMITS.value) return null;
  return Math.round(value * 100) / 100;
}

/** A chart's parts checked; `columns` and `rows` must agree, as they will be kept. */
function checkChart(
  check: InputChecker,
  input: SizeChartInput,
  current: ShownSizeChart | null,
): ShownSizeChart | null {
  const name =
    input.name === undefined && current
      ? current.name
      : check.text(['name'], input.name, { required: true, max: SIZE_CHART_LIMITS.name });
  const unit = input.unit === undefined && current ? current.unit : input.unit;
  if (unit !== 'in' && unit !== 'cm')
    check.add(['unit'], 'INVALID', 'must be inches or centimetres');

  let columns = current?.columns ?? [];
  if (input.columns !== undefined || !current) {
    const given = input.columns ?? [];
    if (given.length === 0) check.add(['columns'], 'TOO_FEW', 'must measure one thing at least');
    if (given.length > SIZE_CHART_LIMITS.columns) {
      check.add(['columns'], 'TOO_MANY', `may measure ${SIZE_CHART_LIMITS.columns} things at most`);
    }
    // Its own sentences: the field's last part is an index, no name to begin one with.
    const seen = new Set<string>();
    columns = given.map((given, index) => {
      const field = ['columns', String(index)];
      const column = given.trim();
      if (column === '') {
        check.addMessage(field, 'BLANK', "What is measured can't be blank");
      } else if (column.length > SIZE_CHART_LIMITS.column) {
        check.addMessage(
          field,
          'TOO_LONG',
          `What is measured is too long (maximum is ${SIZE_CHART_LIMITS.column} characters)`,
        );
      } else if (seen.has(column.toLowerCase())) {
        check.addMessage(field, 'TAKEN', `${column} is measured already`);
      }
      seen.add(column.toLowerCase());
      return column;
    });
  }

  let rows = current?.rows ?? [];
  if (input.rows !== undefined || input.columns !== undefined || !current) {
    if (input.rows === undefined && current) {
      check.add(['rows'], 'INVALID', 'must be given again when what is measured changes');
    }
    const given = input.rows ?? [];
    if (given.length === 0) check.add(['rows'], 'TOO_FEW', 'must have one size at least');
    if (given.length > SIZE_CHART_LIMITS.rows) {
      check.add(['rows'], 'TOO_MANY', `may have ${SIZE_CHART_LIMITS.rows} sizes at most`);
    }
    const seen = new Set<string>();
    rows = given.map((row, index) => {
      const size =
        check.text(['rows', String(index), 'size'], row.size, {
          required: true,
          max: SIZE_CHART_LIMITS.size,
        }) ?? '';
      if (size && seen.has(size.toLowerCase())) {
        check.add(['rows', String(index), 'size'], 'TAKEN', 'is in the chart already');
      }
      seen.add(size.toLowerCase());
      if (row.values.length !== columns.length) {
        check.add(
          ['rows', String(index), 'values'],
          'INVALID',
          `must have a value for each of the ${columns.length} things measured, or null`,
        );
      }
      const values = row.values.map((value, at) => {
        if (value === null) return null;
        const kept = measurement(value);
        if (kept === null) {
          check.addMessage(
            ['rows', String(index), 'values', String(at)],
            'INVALID',
            `A measurement must be more than 0 and at most ${SIZE_CHART_LIMITS.value}`,
          );
        }
        return kept;
      });
      return { size, values };
    });
  }

  const note =
    input.note === undefined && current
      ? current.note
      : check.text(['note'], input.note, { max: SIZE_CHART_LIMITS.note });
  if (!check.ok) return null;
  return { name: name!, unit: unit as SizeChartUnitValue, columns, rows, note };
}

/** The products of the shop among `ids`, those the rest name being none of its. */
async function missingProducts(tx: Tx, shopId: string, ids: readonly string[]): Promise<number[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM catalog.products
     WHERE shop_id = ${shopId} AND id = ANY(${sql.param([...ids])}::uuid[])`);
  const found = new Set(rows.map((row) => row.id));
  return ids.flatMap((id, index) => (found.has(id) ? [] : [index]));
}

/** The products showing a chart, in the caller's transaction `tx`. */
async function productsShowing(tx: Tx, shopId: string, chartId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ product_id: string }>(sql`
    SELECT product_id FROM catalog.product_size_charts
     WHERE shop_id = ${shopId} AND size_chart_id = ${chartId}
     ORDER BY product_id`);
  return rows.map((row) => row.product_id);
}

/**
 * The charts the products among `productIds` show, by product, in the caller's transaction `tx`:
 * what their storefront pages hold (ADR-406).
 */
export async function shownSizeChartsIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, ShownSizeChart>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    product_id: string;
    name: string;
    unit: SizeChartUnitValue;
    columns: string[];
    rows: SizeChartRow[];
    note: string | null;
  }>(sql`
    SELECT pc.product_id, c.name, c.unit, c.columns, c.rows, c.note
      FROM catalog.product_size_charts pc
      JOIN catalog.size_charts c ON c.shop_id = pc.shop_id AND c.id = pc.size_chart_id
     WHERE pc.shop_id = ${shopId} AND pc.product_id = ANY(${sql.param([...productIds])}::uuid[])`);
  return new Map(
    rows.map((row) => [
      row.product_id,
      { name: row.name, unit: row.unit, columns: row.columns, rows: row.rows, note: row.note },
    ]),
  );
}

/**
 * The shop's size charts (CAT-10, ADR-406): tables of measurements, a row for each size, in
 * inches or centimetres, made, changed and deleted, and given to products, by their IDs or as
 * those of a collection are now. A product shows one chart at most.
 */
@Injectable()
export class SizeChartService {
  constructor(private readonly db: Database) {}

  /** The shop's charts, by name. */
  async list(tenant: TenantContext): Promise<SizeChartRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<ChartRow>(sql`
        SELECT ${COLUMNS} FROM catalog.size_charts c
         WHERE c.shop_id = ${tenant.shopId}
         ORDER BY lower(c.name), c.id`),
    );
    return rows.map(toRecord);
  }

  async get(tenant: TenantContext, id: string): Promise<SizeChartRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => this.load(tx, tenant.shopId, id));
  }

  /** The charts the products among `productIds` show, by product. */
  async ofProducts(
    tenant: TenantContext,
    productIds: readonly string[],
  ): Promise<Map<string, SizeChartRecord>> {
    if (productIds.length === 0) return new Map();
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<ChartRow & { product_id: string }>(sql`
        SELECT pc.product_id, ${COLUMNS}
          FROM catalog.product_size_charts pc
          JOIN catalog.size_charts c ON c.shop_id = pc.shop_id AND c.id = pc.size_chart_id
         WHERE pc.shop_id = ${tenant.shopId}
           AND pc.product_id = ANY(${sql.param([...productIds])}::uuid[])`),
    );
    return new Map(rows.map((row) => [row.product_id, toRecord(row)]));
  }

  async create(
    tenant: TenantContext,
    input: SizeChartInput,
  ): Promise<MutationResult<SizeChartRecord>> {
    const check = new InputChecker();
    const chart = checkChart(check, input, null);
    if (!chart) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: counted } = await tx.execute<{ count: string | number }>(sql`
        SELECT count(*) FROM catalog.size_charts WHERE shop_id = ${tenant.shopId}`);
      if (Number(counted[0]?.count ?? 0) >= SIZE_CHART_LIMITS.charts) {
        return failOne(
          ['name'],
          'TOO_MANY',
          `A shop keeps ${SIZE_CHART_LIMITS.charts} size charts at most`,
        );
      }
      const taken = await this.nameTaken(tx, tenant.shopId, chart.name, null);
      if (taken) return { ok: false, errors: [taken] };
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO catalog.size_charts (shop_id, name, unit, columns, rows, note)
        VALUES (${tenant.shopId}, ${chart.name}, ${chart.unit},
                ${JSON.stringify(chart.columns)}::jsonb, ${JSON.stringify(chart.rows)}::jsonb,
                ${chart.note})
        RETURNING id`);
      const id = rows[0]!.id;
      await appendEvent<SizeChartChangedPayload>(tx, tenant.shopId, {
        type: SizeChartEvents.Created,
        aggregateType: 'size_chart',
        aggregateId: id,
        payload: { productIds: [] },
      });
      return { ok: true, value: (await this.load(tx, tenant.shopId, id))! };
    });
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: SizeChartInput,
  ): Promise<MutationResult<SizeChartRecord>> {
    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const current = await this.load(tx, tenant.shopId, id, true);
        if (!current) return failOne(['id'], 'NOT_FOUND', 'No size chart of the shop has this ID');
        const check = new InputChecker();
        const chart = checkChart(check, input, current);
        if (!chart) return { ok: false, errors: check.errors };
        const taken = await this.nameTaken(tx, tenant.shopId, chart.name, id);
        if (taken) return { ok: false, errors: [taken] };
        const before: ShownSizeChart = {
          name: current.name,
          unit: current.unit,
          columns: current.columns,
          rows: current.rows,
          note: current.note,
        };
        if (JSON.stringify(chart) === JSON.stringify(before)) return { ok: true, value: current };
        await tx.execute(sql`
          UPDATE catalog.size_charts
             SET name = ${chart.name}, unit = ${chart.unit},
                 columns = ${JSON.stringify(chart.columns)}::jsonb,
                 rows = ${JSON.stringify(chart.rows)}::jsonb, note = ${chart.note},
                 updated_at = now()
           WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
        await appendEvent<SizeChartChangedPayload>(tx, tenant.shopId, {
          type: SizeChartEvents.Updated,
          aggregateType: 'size_chart',
          aggregateId: id,
          payload: { productIds: await productsShowing(tx, tenant.shopId, id) },
        });
        return { ok: true, value: (await this.load(tx, tenant.shopId, id))! };
      });
    } catch (error) {
      if (isUniqueViolation(error))
        return failOne(['name'], 'TAKEN', 'is the name of another chart');
      throw error;
    }
  }

  /** Deletes a chart: the products showing it show none. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<string>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const productIds = await productsShowing(tx, tenant.shopId, id);
      const { rows } = await tx.execute<{ id: string }>(sql`
        DELETE FROM catalog.size_charts WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING id`);
      if (!rows[0]) return failOne(['id'], 'NOT_FOUND', 'No size chart of the shop has this ID');
      await appendEvent<SizeChartChangedPayload>(tx, tenant.shopId, {
        type: SizeChartEvents.Deleted,
        aggregateType: 'size_chart',
        aggregateId: id,
        payload: { productIds },
      });
      return { ok: true, value: id };
    });
  }

  /**
   * Gives products a chart, in place of any they had, or takes theirs away when `chartId` is
   * null: those `productIds` names, up to 250, and those `collectionId`'s collection has now.
   * The products whose chart changed.
   */
  async setForProducts(
    tenant: TenantContext,
    chartId: string | null,
    target: { productIds?: readonly string[] | null; collectionId?: string | null },
  ): Promise<MutationResult<string[]>> {
    const productIds = [...new Set(target.productIds ?? [])];
    if (productIds.length > SIZE_CHART_LIMITS.products) {
      return failOne(
        ['productIds'],
        'TOO_MANY',
        `A chart is given to ${SIZE_CHART_LIMITS.products} products at most at once`,
      );
    }
    if (productIds.length === 0 && !target.collectionId) {
      return failOne(['productIds'], 'BLANK', 'Name products, or a collection');
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const errors: FieldError[] = [];
      if (chartId && !(await this.load(tx, tenant.shopId, chartId))) {
        errors.push({
          field: ['sizeChartId'],
          code: 'NOT_FOUND',
          message: 'No size chart of the shop has this ID',
        });
      }
      for (const index of await missingProducts(tx, tenant.shopId, productIds)) {
        errors.push({
          field: ['productIds', String(index)],
          code: 'NOT_FOUND',
          message: 'No product of the shop has this ID',
        });
      }
      const ids = new Set(productIds);
      if (target.collectionId) {
        const { rows: found } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM catalog.collections
           WHERE shop_id = ${tenant.shopId} AND id = ${target.collectionId}`);
        if (!found[0]) {
          errors.push({
            field: ['collectionId'],
            code: 'NOT_FOUND',
            message: 'No collection of the shop has this ID',
          });
        } else {
          const { rows } = await tx.execute<{ product_id: string }>(sql`
            SELECT product_id FROM catalog.collection_products
             WHERE shop_id = ${tenant.shopId} AND collection_id = ${target.collectionId}`);
          for (const row of rows) ids.add(row.product_id);
        }
      }
      if (errors.length > 0) return { ok: false, errors };
      const all = [...ids];
      if (all.length === 0) return { ok: true, value: [] };
      const { rows: changed } = chartId
        ? await tx.execute<{ product_id: string }>(sql`
            INSERT INTO catalog.product_size_charts (shop_id, product_id, size_chart_id)
            SELECT ${tenant.shopId}, u.id, ${chartId}
              FROM unnest(${sql.param(all)}::uuid[]) AS u(id)
            ON CONFLICT (shop_id, product_id) DO UPDATE SET size_chart_id = excluded.size_chart_id
             WHERE catalog.product_size_charts.size_chart_id <> excluded.size_chart_id
            RETURNING product_id`)
        : await tx.execute<{ product_id: string }>(sql`
            DELETE FROM catalog.product_size_charts
             WHERE shop_id = ${tenant.shopId} AND product_id = ANY(${sql.param(all)}::uuid[])
            RETURNING product_id`);
      const changedIds = changed.map((row) => row.product_id).sort();
      if (changedIds.length > 0) {
        await appendEvent<SizeChartChangedPayload & { sizeChartId: string | null }>(
          tx,
          tenant.shopId,
          {
            type: SizeChartEvents.ProductsUpdated,
            aggregateType: 'product_size_chart',
            aggregateId: chartId ?? tenant.shopId,
            payload: { productIds: changedIds, sizeChartId: chartId },
          },
        );
      }
      return { ok: true, value: changedIds };
    });
  }

  private async load(
    tx: Tx,
    shopId: string,
    id: string,
    lock = false,
  ): Promise<SizeChartRecord | null> {
    const { rows } = await tx.execute<ChartRow>(sql`
      SELECT ${COLUMNS} FROM catalog.size_charts c
       WHERE c.shop_id = ${shopId} AND c.id = ${id}
       ${lock ? sql`FOR UPDATE` : sql``}`);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** The error for a name another of the shop's charts has, ignoring case. */
  private async nameTaken(
    tx: Tx,
    shopId: string,
    name: string,
    except: string | null,
  ): Promise<FieldError | null> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM catalog.size_charts
       WHERE shop_id = ${shopId} AND lower(name) = lower(${name})
         ${except ? sql`AND id <> ${except}` : sql``}`);
    return rows[0]
      ? { field: ['name'], code: 'TAKEN', message: 'is the name of another chart' }
      : null;
  }
}

/** Gives a duplicated product's copy the chart it shows, in the duplicate's transaction `tx`. */
export async function copySizeChartIn(
  tx: Tx,
  shopId: string,
  originalId: string,
  copyId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO catalog.product_size_charts (shop_id, product_id, size_chart_id)
    SELECT shop_id, ${copyId}, size_chart_id FROM catalog.product_size_charts
     WHERE shop_id = ${shopId} AND product_id = ${originalId}`);
}
