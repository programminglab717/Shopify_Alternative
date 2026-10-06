import { randomBytes } from 'node:crypto';
import { checkSeo, type SeoInputValue, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { searchKey } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { MAX_RULES, checkRules, type RuleColumn, type RuleRelation } from './collection-rules.js';
import { refreshMemberships } from './collection-store.js';
import {
  CatalogEvents,
  type CollectionCreatedPayload,
  type CollectionDeletedPayload,
  type CollectionUpdatedPayload,
} from './events.js';
import { handleCandidate, movedFrom, toHandle } from './handle.js';
import {
  InputChecker,
  LIMITS,
  fail,
  failOne,
  isUniqueViolation,
  type FieldError,
  type MutationResult,
} from './input-checker.js';
import { queryProducts } from './product-store.js';
import type { CollectionRecord, Page, ProductRecord } from './records.js';
import {
  collections,
  type CollectionRow,
  type CollectionRuleValue,
  type CollectionSortOrderValue,
} from './schema.js';

export interface CollectionRuleInput {
  column: RuleColumn;
  relation: RuleRelation;
  condition: string;
}

export interface CollectionRuleSetInput {
  /** Any rule may match, instead of all. */
  appliedDisjunctively: boolean;
  rules: CollectionRuleInput[];
}

export interface CreateCollectionInput {
  title: string;
  handle?: string | null;
  description?: string | null;
  sortOrder?: CollectionSortOrderValue | null;
  /** What search engines are told in place of its title and description (ADR-231). */
  seo?: SeoInputValue | null;
  /** Makes a smart collection. */
  ruleSet?: CollectionRuleSetInput | null;
  /** For a manual collection: its first products, in order. */
  productIds?: string[] | null;
}

/** Omitted fields stay as they are. A collection stays manual or smart. */
export interface UpdateCollectionInput {
  id: string;
  title?: string | null;
  handle?: string | null;
  description?: string | null;
  sortOrder?: CollectionSortOrderValue | null;
  ruleSet?: CollectionRuleSetInput | null;
  /** A field left out stays as it is; null or blank clears it (ADR-231). */
  seo?: SeoInputValue | null;
  /**
   * With a new handle: the collection's old address sends shoppers to its new one, as Shopify's
   * `redirectNewHandle` does. The online store writes the redirect on the event (ADR-053).
   */
  redirectNewHandle?: boolean | null;
}

export interface ProductMove {
  id: string;
  /** 1 is first. */
  newPosition: number;
}

/** Where a page of a collection's products starts: after this product and its sort key. */
export interface CollectionCursor {
  id: string;
  key: string | null;
}

/** A page cursor that does not fit the collection's sort order, e.g. edited by hand. */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

export interface CollectionProductsOptions {
  first: number;
  after?: CollectionCursor | null;
}

const PRODUCTS_COUNT = sql<number>`(SELECT count(*)::int FROM catalog.collection_products cp
                                     WHERE cp.shop_id = ${collections.shopId}
                                       AND cp.collection_id = ${collections.id})`;

function toRecord(row: CollectionRow & { productsCount: number }): CollectionRecord {
  return {
    id: row.id,
    title: row.title,
    handle: row.handle,
    description: row.description,
    sortOrder: row.sortOrder,
    rules: row.rules ?? null,
    disjunctive: row.disjunctive,
    seo: { title: row.seoTitle, description: row.seoDescription },
    productsCount: row.productsCount,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * How each sort order sorts a collection's products, as SQL over `p` for collection `id`: the
 * sort key (also what cursors carry), its type, the direction, and the ORDER BY. Ties break on
 * product id.
 */
function sortSpec(
  order: CollectionSortOrderValue,
  shopId: string,
  collectionId: string,
): { key: SQL; type: SQL; descending: boolean; order: SQL } {
  const spec = sortKey(order, shopId, collectionId);
  const direction = spec.descending ? sql`DESC` : sql`ASC`;
  const byCreation = order === 'created' || order === 'created_desc';
  return {
    ...spec,
    order: byCreation
      ? sql`p.id ${direction}`
      : sql`${spec.key} ${direction} NULLS LAST, p.id ${direction}`,
  };
}

function sortKey(
  order: CollectionSortOrderValue,
  shopId: string,
  collectionId: string,
): { key: SQL; type: SQL; descending: boolean } {
  const price = (fn: SQL) =>
    sql`(SELECT ${fn}(v.price) FROM catalog.variants v
          WHERE v.shop_id = p.shop_id AND v.product_id = p.id)`;
  switch (order) {
    case 'manual':
      return {
        key: sql`(SELECT cp.position FROM catalog.collection_products cp
                   WHERE cp.shop_id = ${shopId} AND cp.collection_id = ${collectionId}
                     AND cp.product_id = p.id)`,
        type: sql`integer`,
        descending: false,
      };
    case 'alpha_asc':
    case 'alpha_desc':
      return { key: sql`lower(p.title)`, type: sql`text`, descending: order === 'alpha_desc' };
    case 'price_asc':
      return { key: price(sql`min`), type: sql`bigint`, descending: false };
    case 'price_desc':
      return { key: price(sql`max`), type: sql`bigint`, descending: true };
    case 'created':
    case 'created_desc':
      return { key: sql`NULL`, type: sql`text`, descending: order === 'created_desc' };
  }
}

/**
 * Collections, manual and smart, like Shopify's. Smart collection membership is kept up to date
 * as products change (see collection-store.ts), so both kinds read the same way.
 */
@Injectable()
export class CollectionService {
  constructor(private readonly db: Database) {}

  async create(
    tenant: TenantContext,
    input: CreateCollectionInput,
  ): Promise<MutationResult<CollectionRecord>> {
    const check = new InputChecker();
    const title = check.text(['input', 'title'], input.title, {
      required: true,
      max: LIMITS.title,
    });
    const description =
      check.text(['input', 'description'], input.description, { max: LIMITS.description }) ?? '';
    const seo = checkSeo(check, ['input', 'seo'], input.seo);
    const requestedHandle =
      input.handle === null || input.handle === undefined
        ? null
        : check.handle(['input', 'handle'], input.handle);
    const smart = input.ruleSet !== null && input.ruleSet !== undefined;
    const rules = smart ? this.checkRuleSet(check, input.ruleSet!, tenant) : null;
    const sortOrder = input.sortOrder ?? (smart ? 'created_desc' : 'manual');
    if (smart && sortOrder === 'manual') {
      check.addMessage(
        ['input', 'sortOrder'],
        'INVALID',
        "Smart collections can't be sorted by hand",
      );
    }
    const productIds = input.productIds ?? [];
    if (smart && productIds.length > 0) {
      check.addMessage(
        ['input', 'productIds'],
        'INVALID',
        'Rules choose the products of a smart collection',
      );
    }
    if (productIds.length > LIMITS.batch) {
      check.add(['input', 'productIds'], 'TOO_MANY', `can have at most ${LIMITS.batch}`);
    }
    if (!check.ok || title === null) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const id = newId();
      const base = requestedHandle ?? (toHandle(title) || 'collection');
      const values = {
        shopId: tenant.shopId,
        id,
        title,
        description,
        sortOrder,
        rules,
        disjunctive: input.ruleSet?.appliedDisjunctively ?? false,
        seoTitle: seo.title ?? null,
        seoDescription: seo.description ?? null,
        searchText: searchKey(title),
      };
      let row: CollectionRow | undefined;
      for (let attempt = 0; attempt < LIMITS.handleAttempts && !row; attempt++) {
        const handle = requestedHandle ?? handleCandidate(base, attempt);
        [row] = await this.insertCollection(tx, { ...values, handle });
        if (!row && requestedHandle) {
          return failOne<CollectionRecord>(
            ['input', 'handle'],
            'TAKEN',
            'Handle is already in use',
          );
        }
      }
      if (!row) {
        const handle = `${base.slice(0, 80)}-${randomBytes(3).toString('hex')}`;
        [row] = await this.insertCollection(tx, { ...values, handle });
      }
      if (!row) throw new Error('Could not allocate a collection handle');

      if (smart) {
        await refreshMemberships(tx, tenant, { collectionIds: [id] });
      } else if (productIds.length > 0) {
        const missing = await this.missingProducts(tx, tenant.shopId, productIds);
        if (missing.length > 0) {
          return fail<CollectionRecord>(
            missing.map((index) => ({
              field: ['input', 'productIds', String(index)],
              code: 'NOT_FOUND',
              message: 'Product not found',
            })),
          );
        }
        await this.append(tx, tenant.shopId, id, productIds);
      }
      await appendEvent<CollectionCreatedPayload>(tx, tenant.shopId, {
        type: CatalogEvents.CollectionCreated,
        aggregateType: 'collection',
        aggregateId: id,
        payload: { handle: row.handle, smart },
      });
      return { ok: true, value: (await this.load(tx, tenant.shopId, id))! };
    });
  }

  async update(
    tenant: TenantContext,
    input: UpdateCollectionInput,
  ): Promise<MutationResult<CollectionRecord>> {
    const check = new InputChecker();
    const changes: Partial<
      Pick<
        CollectionRow,
        | 'title'
        | 'handle'
        | 'description'
        | 'sortOrder'
        | 'rules'
        | 'disjunctive'
        | 'seoTitle'
        | 'seoDescription'
      >
    > = {};
    if (input.title !== undefined) {
      const title = check.text(['input', 'title'], input.title, {
        required: true,
        max: LIMITS.title,
      });
      if (title !== null) changes.title = title;
    }
    if (input.handle === null) {
      check.add(['input', 'handle'], 'BLANK', "can't be blank");
    } else if (input.handle !== undefined) {
      const handle = check.handle(['input', 'handle'], input.handle);
      if (handle !== null) changes.handle = handle;
    }
    if (input.description !== undefined) {
      changes.description =
        check.text(['input', 'description'], input.description, { max: LIMITS.description }) ?? '';
    }
    if (input.sortOrder !== undefined) {
      if (input.sortOrder === null) check.add(['input', 'sortOrder'], 'BLANK', "can't be blank");
      else changes.sortOrder = input.sortOrder;
    }
    if (input.ruleSet) {
      const rules = this.checkRuleSet(check, input.ruleSet, tenant);
      if (rules) changes.rules = rules;
      changes.disjunctive = input.ruleSet.appliedDisjunctively;
    }
    const seo = checkSeo(check, ['input', 'seo'], input.seo);
    if (seo.title !== undefined) changes.seoTitle = seo.title;
    if (seo.description !== undefined) changes.seoDescription = seo.description;
    if (!check.ok) return fail(check.errors);

    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const [current] = await tx
          .select()
          .from(collections)
          .where(and(eq(collections.shopId, tenant.shopId), eq(collections.id, input.id)))
          .for('update');
        if (!current)
          return failOne<CollectionRecord>(['input', 'id'], 'NOT_FOUND', 'Collection not found');
        const smart = current.rules !== null;
        if (input.ruleSet !== undefined && !smart) {
          return failOne<CollectionRecord>(
            ['input', 'ruleSet'],
            'INVALID',
            "A manual collection can't have rules",
          );
        }
        if (input.ruleSet === null && smart) {
          return failOne<CollectionRecord>(
            ['input', 'ruleSet'],
            'BLANK',
            'A smart collection needs rules',
          );
        }
        if (smart && changes.sortOrder === 'manual') {
          return failOne<CollectionRecord>(
            ['input', 'sortOrder'],
            'INVALID',
            "Smart collections can't be sorted by hand",
          );
        }
        const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter(
          (key) => JSON.stringify(changes[key]) !== JSON.stringify(current[key]),
        );
        if (changed.length > 0) {
          if (changed.includes('handle') && changes.handle) {
            const [taken] = await tx
              .select({ id: collections.id })
              .from(collections)
              .where(
                and(
                  eq(collections.shopId, tenant.shopId),
                  eq(collections.handle, changes.handle),
                  ne(collections.id, current.id),
                ),
              );
            if (taken) {
              return failOne<CollectionRecord>(
                ['input', 'handle'],
                'TAKEN',
                'Handle is already in use',
              );
            }
          }
          const [updated] = await tx
            .update(collections)
            .set({
              ...changes,
              searchText: searchKey(changes.title ?? current.title),
              version: current.version + 1,
              updatedAt: sql`now()`,
            })
            .where(and(eq(collections.shopId, tenant.shopId), eq(collections.id, current.id)))
            .returning({ version: collections.version });
          if (changed.includes('rules') || changed.includes('disjunctive')) {
            await refreshMemberships(tx, tenant, { collectionIds: [current.id] });
          }
          await appendEvent<CollectionUpdatedPayload>(tx, tenant.shopId, {
            type: CatalogEvents.CollectionUpdated,
            aggregateType: 'collection',
            aggregateId: current.id,
            payload: {
              changed: [...new Set(changed.map((key) => (key === 'disjunctive' ? 'rules' : key)))],
              version: updated!.version,
              ...movedFrom(current.handle, changed, input.redirectNewHandle),
            },
          });
        }
        return { ok: true, value: (await this.load(tx, tenant.shopId, current.id))! };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return failOne(['input', 'handle'], 'TAKEN', 'Handle is already in use');
      }
      throw error;
    }
  }

  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [deleted] = await tx
        .delete(collections)
        .where(and(eq(collections.shopId, tenant.shopId), eq(collections.id, id)))
        .returning({ id: collections.id, handle: collections.handle });
      if (!deleted) return failOne(['input', 'id'], 'NOT_FOUND', 'Collection not found');
      await appendEvent<CollectionDeletedPayload>(tx, tenant.shopId, {
        type: CatalogEvents.CollectionDeleted,
        aggregateType: 'collection',
        aggregateId: deleted.id,
        payload: { handle: deleted.handle },
      });
      return { ok: true, value: { id: deleted.id } };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<CollectionRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => this.load(tx, tenant.shopId, id));
  }

  async getByHandle(tenant: TenantContext, handle: string): Promise<CollectionRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select({ ...allColumns(), productsCount: PRODUCTS_COUNT })
        .from(collections)
        .where(and(eq(collections.shopId, tenant.shopId), eq(collections.handle, handle)));
      return row ? toRecord(row) : null;
    });
  }

  /** Collections, newest first, optionally those whose title has every word of `query`. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null; query?: string | null },
  ): Promise<Page<CollectionRecord>> {
    const conditions: SQL[] = [eq(collections.shopId, tenant.shopId)];
    if (options.after) conditions.push(sql`${collections.id} < ${options.after}`);
    for (const token of searchKey(options.query ?? '')
      .split(' ')
      .filter(Boolean)) {
      conditions.push(sql`${collections.searchText} LIKE ${`%${token}%`}`);
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select({ ...allColumns(), productsCount: PRODUCTS_COUNT })
        .from(collections)
        .where(and(...conditions))
        .orderBy(sql`${collections.id} DESC`)
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /**
   * A page of the collections each product is in, by collection ID, with one query for all the
   * products: a page of products asks for theirs together. Products in none get an empty page.
   */
  async collectionsOfProducts(
    tenant: TenantContext,
    productIds: readonly string[],
    options: { first: number; after?: string | null },
  ): Promise<Map<string, Page<CollectionRecord>>> {
    const pages = new Map<string, Page<CollectionRecord>>(
      productIds.map((id) => [id, { items: [], hasNextPage: false }]),
    );
    if (productIds.length === 0) return pages;
    return this.db.tenant(tenant.shopId, async (tx) => {
      // The first page of each product's memberships, one more to tell whether there are more.
      const { rows: memberships } = await tx.execute<{
        product_id: string;
        collection_id: string;
      }>(sql`
        SELECT product_id, collection_id FROM (
          SELECT cp.product_id, cp.collection_id,
                 row_number() OVER (PARTITION BY cp.product_id ORDER BY cp.collection_id) AS n
            FROM catalog.collection_products cp
           WHERE cp.shop_id = ${tenant.shopId}
             AND cp.product_id = ANY(${sql.param([...productIds])}::uuid[])
             AND (${options.after ?? null}::uuid IS NULL OR cp.collection_id > ${options.after ?? null}::uuid)
        ) ranked
         WHERE n <= ${options.first + 1}
         ORDER BY product_id, collection_id`);
      const ids = [...new Set(memberships.map((row) => row.collection_id))];
      if (ids.length === 0) return pages;
      const rows = await tx
        .select({ ...allColumns(), productsCount: PRODUCTS_COUNT })
        .from(collections)
        .where(and(eq(collections.shopId, tenant.shopId), inArray(collections.id, ids)));
      const records = new Map(rows.map((row) => [row.id, toRecord(row)]));
      const byProduct = new Map<string, CollectionRecord[]>();
      for (const row of memberships) {
        const record = records.get(row.collection_id);
        if (record)
          byProduct.set(row.product_id, [...(byProduct.get(row.product_id) ?? []), record]);
      }
      for (const [productId, found] of byProduct) {
        pages.set(productId, {
          items: found.slice(0, options.first),
          hasNextPage: found.length > options.first,
        });
      }
      return pages;
    });
  }

  /** A page of the collection's products in its sort order; null if there is no collection. */
  async products(
    tenant: TenantContext,
    collectionId: string,
    options: CollectionProductsOptions,
  ): Promise<(Page<ProductRecord> & { cursors: CollectionCursor[] }) | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [collection] = await tx
        .select({ sortOrder: collections.sortOrder })
        .from(collections)
        .where(and(eq(collections.shopId, tenant.shopId), eq(collections.id, collectionId)));
      if (!collection) return null;
      const spec = sortSpec(collection.sortOrder, tenant.shopId, collectionId);
      const conditions = [
        sql`EXISTS (SELECT 1 FROM catalog.collection_products cp
                     WHERE cp.shop_id = p.shop_id AND cp.collection_id = ${collectionId}
                       AND cp.product_id = p.id)`,
      ];
      if (options.after) {
        // Orders by creation carry no key: the UUIDv7 id is the creation order.
        const { id, key } = options.after;
        const numeric =
          collection.sortOrder === 'manual' || collection.sortOrder.startsWith('price');
        if (key !== null && numeric && !/^\d{1,18}$/.test(key)) throw new InvalidCursorError();
        const comparison = spec.descending ? sql`<` : sql`>`;
        conditions.push(
          key !== null
            ? sql`(${spec.key}, p.id) ${comparison} (${key}::${spec.type}, ${id}::uuid)`
            : sql`p.id ${comparison} ${id}::uuid`,
        );
      }
      const rows = await queryProducts(tx, tenant.shopId, {
        where: sql.join(conditions, sql` AND `),
        order: spec.order,
        limit: options.first + 1,
        key: spec.key,
      });
      const page = rows.slice(0, options.first);
      return {
        items: page.map((row) => row.record),
        cursors: page.map((row) => ({ id: row.record.id, key: row.key })),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /**
   * Collections of the shop by title, in the caller's transaction `tx`, for read models built
   * outside the catalog, such as the storefront's: all of them, or those of `ids`, the smart
   * ones, or those holding any of the products `containing`.
   */
  async recordsOf(
    tx: Tx,
    shopId: string,
    filter: { ids?: readonly string[]; smart?: boolean; containing?: readonly string[] } = {},
  ): Promise<CollectionRecord[]> {
    const conditions: SQL[] = [eq(collections.shopId, shopId)];
    if (filter.ids) {
      conditions.push(sql`${collections.id} = ANY(${sql.param([...filter.ids])}::uuid[])`);
    }
    if (filter.smart) conditions.push(isNotNull(collections.rules));
    if (filter.containing) {
      conditions.push(sql`EXISTS (SELECT 1 FROM catalog.collection_products cp
                                   WHERE cp.shop_id = ${collections.shopId}
                                     AND cp.collection_id = ${collections.id}
                                     AND cp.product_id = ANY(${sql.param([...filter.containing])}::uuid[]))`);
    }
    const rows = await tx
      .select({ ...allColumns(), productsCount: PRODUCTS_COUNT })
      .from(collections)
      .where(and(...conditions))
      .orderBy(sql`lower(${collections.title})`, collections.id);
    return rows.map(toRecord);
  }

  /** The handle a collection has now, or null once it is gone, in the caller's transaction `tx`. */
  async handleOf(tx: Tx, shopId: string, id: string): Promise<string | null> {
    const [row] = await tx
      .select({ handle: collections.handle })
      .from(collections)
      .where(and(eq(collections.shopId, shopId), eq(collections.id, id)));
    return row?.handle ?? null;
  }

  /** The IDs of a collection's active products in its order, in the caller's transaction `tx`. */
  async activeProductIdsOf(
    tx: Tx,
    shopId: string,
    collection: Pick<CollectionRecord, 'id' | 'sortOrder'>,
  ): Promise<string[]> {
    const spec = sortSpec(collection.sortOrder, shopId, collection.id);
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT p.id FROM catalog.products p
       WHERE p.shop_id = ${shopId} AND p.status = 'active'
         AND EXISTS (SELECT 1 FROM catalog.collection_products cp
                      WHERE cp.shop_id = p.shop_id AND cp.collection_id = ${collection.id}
                        AND cp.product_id = p.id)
       ORDER BY ${spec.order}`);
    return rows.map((row) => row.id);
  }

  /** Adds products to the end of a manual collection. Products already in it stay put. */
  async addProducts(
    tenant: TenantContext,
    collectionId: string,
    productIds: string[],
  ): Promise<MutationResult<CollectionRecord>> {
    return this.changeMembers(tenant, collectionId, productIds, async (tx) => {
      const missing = await this.missingProducts(tx, tenant.shopId, productIds);
      if (missing.length > 0) {
        return missing.map((index) => ({
          field: ['productIds', String(index)],
          code: 'NOT_FOUND' as const,
          message: 'Product not found',
        }));
      }
      await this.append(tx, tenant.shopId, collectionId, productIds);
      return [];
    });
  }

  async removeProducts(
    tenant: TenantContext,
    collectionId: string,
    productIds: string[],
  ): Promise<MutationResult<CollectionRecord>> {
    return this.changeMembers(tenant, collectionId, productIds, async (tx) => {
      await tx.execute(sql`
        DELETE FROM catalog.collection_products
         WHERE shop_id = ${tenant.shopId} AND collection_id = ${collectionId}
           AND product_id = ANY(${sql.param(productIds)}::uuid[])`);
      await this.renumber(tx, tenant.shopId, collectionId);
      return [];
    });
  }

  /** Moves products within a manual collection, one move after another. */
  async reorderProducts(
    tenant: TenantContext,
    collectionId: string,
    moves: ProductMove[],
  ): Promise<MutationResult<CollectionRecord>> {
    return this.changeMembers(
      tenant,
      collectionId,
      moves.map((move) => move.id),
      async (tx) => {
        const { rows } = await tx.execute<{ product_id: string }>(sql`
          SELECT product_id FROM catalog.collection_products
           WHERE shop_id = ${tenant.shopId} AND collection_id = ${collectionId}
           ORDER BY position, product_id`);
        const order = rows.map((row) => row.product_id);
        const check = new InputChecker();
        moves.forEach((move, index) => {
          const from = order.indexOf(move.id);
          if (from === -1) {
            check.addMessage(
              ['moves', String(index), 'id'],
              'NOT_FOUND',
              'The product is not in this collection',
            );
            return;
          }
          if (
            !Number.isInteger(move.newPosition) ||
            move.newPosition < 1 ||
            move.newPosition > order.length
          ) {
            check.add(
              ['moves', String(index), 'newPosition'],
              'INVALID',
              `must be from 1 to ${order.length}`,
            );
            return;
          }
          order.splice(from, 1);
          order.splice(move.newPosition - 1, 0, move.id);
        });
        if (!check.ok) return check.errors;
        await tx.execute(sql`
          UPDATE catalog.collection_products cp
             SET position = u.position
            FROM unnest(${sql.param(order)}::uuid[]) WITH ORDINALITY AS u(product_id, position)
           WHERE cp.shop_id = ${tenant.shopId} AND cp.collection_id = ${collectionId}
             AND cp.product_id = u.product_id AND cp.position <> u.position`);
        return [];
      },
    );
  }

  /** Locks a manual collection, applies `change`, bumps its version and records the change. */
  private async changeMembers(
    tenant: TenantContext,
    collectionId: string,
    productIds: string[],
    change: (tx: Tx) => Promise<FieldError[]>,
  ): Promise<MutationResult<CollectionRecord>> {
    if (productIds.length === 0) {
      return failOne(['productIds'], 'BLANK', 'Products must include at least one');
    }
    if (productIds.length > LIMITS.batch) {
      return failOne(['productIds'], 'TOO_MANY', `Products can have at most ${LIMITS.batch}`);
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [current] = await tx
        .select()
        .from(collections)
        .where(and(eq(collections.shopId, tenant.shopId), eq(collections.id, collectionId)))
        .for('update');
      if (!current) return failOne(['id'], 'NOT_FOUND', 'Collection not found');
      if (current.rules !== null) {
        return failOne(['id'], 'INVALID', 'Rules choose the products of a smart collection');
      }
      const errors = await change(tx);
      if (errors.length > 0) return fail(errors);
      const [updated] = await tx
        .update(collections)
        .set({ version: current.version + 1, updatedAt: sql`now()` })
        .where(and(eq(collections.shopId, tenant.shopId), eq(collections.id, collectionId)))
        .returning({ version: collections.version });
      await appendEvent<CollectionUpdatedPayload>(tx, tenant.shopId, {
        type: CatalogEvents.CollectionUpdated,
        aggregateType: 'collection',
        aggregateId: collectionId,
        payload: { changed: ['products'], version: updated!.version },
      });
      return { ok: true, value: (await this.load(tx, tenant.shopId, collectionId))! };
    });
  }

  private checkRuleSet(
    check: InputChecker,
    ruleSet: CollectionRuleSetInput,
    tenant: TenantContext,
  ): CollectionRuleValue[] | null {
    if (ruleSet.rules.length === 0) {
      check.addMessage(['input', 'ruleSet', 'rules'], 'BLANK', 'Add at least one rule');
      return null;
    }
    if (ruleSet.rules.length > MAX_RULES) {
      check.addMessage(
        ['input', 'ruleSet', 'rules'],
        'TOO_MANY',
        `A collection can have at most ${MAX_RULES} rules`,
      );
      return null;
    }
    const rules = ruleSet.rules.map((rule) => ({
      column: rule.column,
      relation: rule.relation,
      condition: rule.condition.trim(),
    }));
    const checked = checkRules(rules, tenant.currency);
    if (!checked.ok) {
      for (const problem of checked.problems) {
        check.addMessage(
          ['input', 'ruleSet', 'rules', String(problem.index), problem.field],
          'INVALID',
          problem.message,
        );
      }
      return null;
    }
    return rules;
  }

  private async load(tx: Tx, shopId: string, id: string): Promise<CollectionRecord | null> {
    const [row] = await tx
      .select({ ...allColumns(), productsCount: PRODUCTS_COUNT })
      .from(collections)
      .where(and(eq(collections.shopId, shopId), eq(collections.id, id)));
    return row ? toRecord(row) : null;
  }

  /** Indexes of ids that name no product of the shop. */
  private async missingProducts(tx: Tx, shopId: string, productIds: string[]): Promise<number[]> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM catalog.products
       WHERE shop_id = ${shopId} AND id = ANY(${sql.param(productIds)}::uuid[])`);
    const found = new Set(rows.map((row) => row.id));
    return productIds.flatMap((id, index) => (found.has(id) ? [] : [index]));
  }

  /** Appends products, in order, after the collection's last one; skips members. */
  private async append(
    tx: Tx,
    shopId: string,
    collectionId: string,
    productIds: string[],
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO catalog.collection_products (shop_id, collection_id, product_id, position)
      SELECT ${shopId}, ${collectionId}, u.product_id,
             coalesce((SELECT max(position) FROM catalog.collection_products
                        WHERE shop_id = ${shopId} AND collection_id = ${collectionId}), 0)
               + row_number() OVER (ORDER BY u.ordinality)
        FROM unnest(${sql.param(productIds)}::uuid[]) WITH ORDINALITY AS u(product_id, ordinality)
       WHERE NOT EXISTS (SELECT 1 FROM catalog.collection_products cp
                          WHERE cp.shop_id = ${shopId} AND cp.collection_id = ${collectionId}
                            AND cp.product_id = u.product_id)
      ON CONFLICT DO NOTHING`);
  }

  private async renumber(tx: Tx, shopId: string, collectionId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE catalog.collection_products cp
         SET position = r.rank
        FROM (SELECT product_id, row_number() OVER (ORDER BY position, product_id) AS rank
                FROM catalog.collection_products
               WHERE shop_id = ${shopId} AND collection_id = ${collectionId}) r
       WHERE cp.shop_id = ${shopId} AND cp.collection_id = ${collectionId}
         AND cp.product_id = r.product_id AND cp.position <> r.rank`);
  }

  private insertCollection(tx: Tx, values: typeof collections.$inferInsert) {
    return tx
      .insert(collections)
      .values(values)
      .onConflictDoNothing({ target: [collections.shopId, collections.handle] })
      .returning();
  }
}

function allColumns() {
  return {
    shopId: collections.shopId,
    id: collections.id,
    title: collections.title,
    handle: collections.handle,
    description: collections.description,
    sortOrder: collections.sortOrder,
    rules: collections.rules,
    disjunctive: collections.disjunctive,
    seoTitle: collections.seoTitle,
    seoDescription: collections.seoDescription,
    searchText: collections.searchText,
    version: collections.version,
    createdAt: collections.createdAt,
    updatedAt: collections.updatedAt,
  };
}
