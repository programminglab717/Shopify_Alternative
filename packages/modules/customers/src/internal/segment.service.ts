import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, isUniqueViolation, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { toCustomerRecord } from './customer.service.js';
import {
  CustomerEvents,
  type SegmentCreatedPayload,
  type SegmentDeletedPayload,
  type SegmentUpdatedPayload,
} from './events.js';
import type { CustomerRecord, Page, SegmentRecord } from './records.js';
import { LIMITS, SEGMENT_TIME_ZONE } from './rules.js';
import { customers, segments, type SegmentRow } from './schema.js';
import { SegmentFieldRegistry, type SegmentField } from './segment-fields.js';
import { SEGMENT_QUERY_LIMITS, SegmentQueryError } from './segment-query.js';
import { compileSegmentQuery, type CompiledSegment } from './segment-sql.js';

export interface SegmentCreateInput {
  name: string;
  /** In the segment query language, e.g. "number_of_orders >= 2 AND city = Lahore". */
  query: string;
}

/** Fields left out stay as they are. */
export interface SegmentUpdateInput {
  name?: string | null;
  query?: string | null;
}

export interface SegmentMembersOptions {
  first: number;
  after?: string | null;
}

const NAME_TAKEN = 'A segment with this name already exists';

function toSegmentRecord(row: SegmentRow): SegmentRecord {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Segments: saved customer filters in the segment query language, such as "bought 2+ times, in
 * Lahore, no order in 60 days". A segment stores its query; its members are the customers who
 * match it when asked, so they are always current. Fields come from the
 * {@link SegmentFieldRegistry}, to which other modules add theirs.
 */
@Injectable()
export class SegmentService {
  constructor(
    private readonly db: Database,
    private readonly registry: SegmentFieldRegistry,
  ) {}

  /** The fields queries can use. */
  fields(): SegmentField[] {
    return this.registry.fields();
  }

  async create(
    tenant: TenantContext,
    input: SegmentCreateInput,
  ): Promise<MutationResult<SegmentRecord>> {
    const check = new InputChecker();
    const name = check.text(['name'], input.name, { required: true, max: LIMITS.segmentName });
    const query = this.#checkQuery(check, tenant, input.query);
    if (!check.ok || !name || !query) return { ok: false, errors: check.errors };
    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const [row] = await tx
          .insert(segments)
          .values({ shopId: tenant.shopId, id: newId(), name, query })
          .returning();
        await appendEvent<SegmentCreatedPayload>(tx, tenant.shopId, {
          type: CustomerEvents.SegmentCreated,
          aggregateType: 'segment',
          aggregateId: row!.id,
          payload: { version: row!.version },
        });
        return { ok: true, value: toSegmentRecord(row!) };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'segments_name_key')) {
        return failOne(['name'], 'TAKEN', NAME_TAKEN);
      }
      throw error;
    }
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: SegmentUpdateInput,
  ): Promise<MutationResult<SegmentRecord>> {
    const check = new InputChecker();
    const name =
      input.name === undefined
        ? undefined
        : check.text(['name'], input.name, { required: true, max: LIMITS.segmentName });
    const query =
      input.query === undefined ? undefined : this.#checkQuery(check, tenant, input.query);
    if (!check.ok) return { ok: false, errors: check.errors };
    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const [current] = await tx
          .select()
          .from(segments)
          .where(and(eq(segments.shopId, tenant.shopId), eq(segments.id, id)))
          .for('update');
        if (!current) return failOne(['id'], 'NOT_FOUND', 'Segment not found');
        const changes: Partial<SegmentRow> = {};
        if (name && name !== current.name) changes.name = name;
        if (query && query !== current.query) changes.query = query;
        const changed = Object.keys(changes);
        if (changed.length === 0) return { ok: true, value: toSegmentRecord(current) };
        const [row] = await tx
          .update(segments)
          .set({ ...changes, version: sql`${segments.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(segments.shopId, tenant.shopId), eq(segments.id, id)))
          .returning();
        await appendEvent<SegmentUpdatedPayload>(tx, tenant.shopId, {
          type: CustomerEvents.SegmentUpdated,
          aggregateType: 'segment',
          aggregateId: id,
          payload: { changed, version: row!.version },
        });
        return { ok: true, value: toSegmentRecord(row!) };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'segments_name_key')) {
        return failOne(['name'], 'TAKEN', NAME_TAKEN);
      }
      throw error;
    }
  }

  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [deleted] = await tx
        .delete(segments)
        .where(and(eq(segments.shopId, tenant.shopId), eq(segments.id, id)))
        .returning({ id: segments.id });
      if (!deleted) return failOne(['id'], 'NOT_FOUND', 'Segment not found');
      await appendEvent<SegmentDeletedPayload>(tx, tenant.shopId, {
        type: CustomerEvents.SegmentDeleted,
        aggregateType: 'segment',
        aggregateId: id,
        payload: {},
      });
      return { ok: true, value: deleted };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<SegmentRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(segments)
        .where(and(eq(segments.shopId, tenant.shopId), eq(segments.id, id)));
      return row ? toSegmentRecord(row) : null;
    });
  }

  /** Segments, newest first. */
  async list(tenant: TenantContext, options: SegmentMembersOptions): Promise<Page<SegmentRecord>> {
    const conditions: SQL[] = [eq(segments.shopId, tenant.shopId)];
    if (options.after) conditions.push(lt(segments.id, options.after));
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(segments)
        .where(and(...conditions))
        .orderBy(desc(segments.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toSegmentRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /**
   * The customers a query matches now, newest first. Throws a {@link SegmentQueryError} for a
   * query that does not parse or check.
   */
  async members(
    tenant: TenantContext,
    query: string,
    options: SegmentMembersOptions,
  ): Promise<Page<CustomerRecord>> {
    const compiled = this.#compile(tenant, query);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        SELECT c.id
          FROM customers.customers c ${compiled.joins}
         WHERE c.shop_id = ${tenant.shopId} AND ${compiled.where}
           ${options.after ? sql`AND c.id < ${options.after}` : sql``}
         ORDER BY c.id DESC
         LIMIT ${options.first + 1}`);
      const ids = rows.slice(0, options.first).map((row) => row.id);
      const found =
        ids.length === 0
          ? []
          : await tx
              .select()
              .from(customers)
              .where(and(eq(customers.shopId, tenant.shopId), inArray(customers.id, ids)));
      const byId = new Map(found.map((row) => [row.id, toCustomerRecord(row)]));
      return {
        items: ids.map((id) => byId.get(id)!),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /** How many customers a query matches now. Throws a {@link SegmentQueryError} for a bad query. */
  async count(tenant: TenantContext, query: string): Promise<number> {
    const compiled = this.#compile(tenant, query);
    return this.db.tenant(tenant.shopId, (tx) => this.#count(tx, tenant.shopId, compiled));
  }

  async #count(tx: Tx, shopId: string, compiled: CompiledSegment): Promise<number> {
    const { rows } = await tx.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
        FROM customers.customers c ${compiled.joins}
       WHERE c.shop_id = ${shopId} AND ${compiled.where}`);
    return rows[0]!.count;
  }

  #compile(tenant: TenantContext, query: string): CompiledSegment {
    return compileSegmentQuery(query, this.registry, {
      shopId: tenant.shopId,
      currency: tenant.currency,
      timeZone: SEGMENT_TIME_ZONE,
    });
  }

  /** The query, trimmed, if it compiles; otherwise null, with the reason as a user error. */
  #checkQuery(check: InputChecker, tenant: TenantContext, value: string | null): string | null {
    const errorsBefore = check.errors.length;
    const query = check.text(['query'], value, {
      required: true,
      max: SEGMENT_QUERY_LIMITS.length,
    });
    if (query === null || check.errors.length > errorsBefore) return null;
    try {
      this.#compile(tenant, query);
      return query;
    } catch (error) {
      if (!(error instanceof SegmentQueryError)) throw error;
      check.addMessage(['query'], 'INVALID', error.message);
      return null;
    }
  }
}
