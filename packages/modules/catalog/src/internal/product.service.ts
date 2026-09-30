import { randomBytes } from 'node:crypto';
import type { TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { searchKey } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { refreshMemberships } from './collection-store.js';
import {
  CatalogEvents,
  type ProductCreatedPayload,
  type ProductDeletedPayload,
  type ProductUpdatedPayload,
} from './events.js';
import { handleCandidate, toHandle } from './handle.js';
import {
  InputChecker,
  LIMITS,
  fail,
  failOne,
  isUniqueViolation,
  type MutationResult,
} from './input-checker.js';
import {
  loadProduct,
  loadProducts,
  lockProduct,
  searchTextOf,
  variantTitle,
} from './product-store.js';
import type { Page, ProductRecord } from './records.js';
import {
  productOptionValues,
  productOptions,
  products,
  variants,
  type ProductRow,
  type ProductStatusValue,
} from './schema.js';
import {
  checkOptionInputs,
  checkVariantFields,
  comboKey,
  combinations,
  resolveOptionValues,
  type OptionInput,
  type VariantFieldsInput,
} from './variant-input.js';

export interface CreateProductInput {
  title: string;
  handle?: string | null;
  description?: string | null;
  status?: ProductStatusValue | null;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[] | null;
  /** Up to three, e.g. [{ name: "Size", values: ["S", "M", "L"] }]. */
  options?: OptionInput[] | null;
  /**
   * With options, defaults to every combination of their values; without, to one variant. Either
   * way priced at zero until updated.
   */
  variants?: VariantFieldsInput[] | null;
}

/** Omitted (undefined) fields stay as they are; null clears optional fields. */
export interface UpdateProductInput {
  id: string;
  title?: string | null;
  handle?: string | null;
  description?: string | null;
  status?: ProductStatusValue | null;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[] | null;
}

export interface ListProductsOptions {
  first: number;
  /** Return products created before this one (UUID); pages run newest first. */
  after?: string | null;
  /** Free-text search over title, vendor, type and tags. */
  query?: string | null;
}

/** Product fields that can be listed for pickers and filters. */
export type ProductFacet = 'tags' | 'productType' | 'vendor';

/**
 * Products, with their options and variants. Every method runs in a tenant transaction for the
 * caller's shop, and also filters by shop explicitly, so isolation holds even if row-level security
 * were off, and Postgres reduces the policy to one check per query (spike 5).
 */
@Injectable()
export class ProductService {
  constructor(private readonly db: Database) {}

  async create(
    tenant: TenantContext,
    input: CreateProductInput,
  ): Promise<MutationResult<ProductRecord>> {
    const check = new InputChecker();
    const title = check.text(['input', 'title'], input.title, {
      required: true,
      max: LIMITS.title,
    });
    const description =
      check.text(['input', 'description'], input.description, { max: LIMITS.description }) ?? '';
    const vendor = check.text(['input', 'vendor'], input.vendor, { max: LIMITS.shortText });
    const productType = check.text(['input', 'productType'], input.productType, {
      max: LIMITS.shortText,
    });
    const tags = check.tags(['input', 'tags'], input.tags);
    const requestedHandle =
      input.handle === null || input.handle === undefined
        ? null
        : check.handle(['input', 'handle'], input.handle);

    const options = checkOptionInputs(check, ['input', 'options'], input.options ?? []);
    const variantInputs =
      input.variants ??
      (options.length > 0
        ? combinations(options).map((optionValues) => ({ optionValues, price: '0' }))
        : [{ price: '0' }]);
    if (variantInputs.length === 0) {
      check.add(['input', 'variants'], 'BLANK', 'must include at least one');
    } else if (variantInputs.length > LIMITS.variants) {
      check.addMessage(
        [input.variants ? 'input' : 'input', input.variants ? 'variants' : 'options'],
        'TOO_MANY',
        `A product can have at most ${LIMITS.variants} variants; this would make ${variantInputs.length}`,
      );
    } else if (options.length === 0 && variantInputs.length > 1) {
      check.addMessage(
        ['input', 'variants'],
        'TOO_MANY',
        'Add options, such as Size or Colour, to sell more than one variant',
      );
    }
    const seen = new Set<string>();
    const variantValues = variantInputs.slice(0, LIMITS.variants).map((variant, index) => {
      const field = ['input', 'variants', String(index)];
      const fields = checkVariantFields(check, field, variant, tenant.currency, {
        requirePrice: true,
      });
      const optionValues = resolveOptionValues(
        check,
        [...field, 'optionValues'],
        fields.optionValues,
        options,
      );
      // Without options, "more than one variant" is already reported above.
      if (optionValues && options.length > 0) {
        const key = comboKey(optionValues);
        if (seen.has(key)) {
          check.addMessage(
            [...field, 'optionValues'],
            'TAKEN',
            `Another variant already has ${variantTitle(optionValues)}`,
          );
        }
        seen.add(key);
      }
      return { fields, optionValues: optionValues ?? [] };
    });
    if (!check.ok || title === null) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const productId = newId();
      const base = requestedHandle ?? (toHandle(title) || 'product');
      const values = {
        shopId: tenant.shopId,
        id: productId,
        title,
        description,
        status: input.status ?? 'draft',
        vendor,
        productType,
        tags,
        searchText: searchTextOf({ title, vendor, productType, tags }),
      };

      let product: ProductRow | undefined;
      for (let attempt = 0; attempt < LIMITS.handleAttempts && !product; attempt++) {
        const handle = requestedHandle ?? handleCandidate(base, attempt);
        [product] = await this.insertProduct(tx, { ...values, handle });
        if (!product && requestedHandle) {
          return failOne<ProductRecord>(['input', 'handle'], 'TAKEN', 'Handle is already in use');
        }
      }
      // Very common titles: fall back to a random suffix.
      if (!product) {
        const handle = `${base.slice(0, 80)}-${randomBytes(3).toString('hex')}`;
        [product] = await this.insertProduct(tx, { ...values, handle });
      }
      if (!product) throw new Error('Could not allocate a product handle');

      // Option and value ids, by position and lowercased name, for the variants below.
      const valueIds = options.map(() => new Map<string, string>());
      if (options.length > 0) {
        const optionRows = options.map((option, index) => ({
          shopId: tenant.shopId,
          id: newId(),
          productId,
          name: option.name,
          position: index + 1,
        }));
        await tx.insert(productOptions).values(optionRows);
        await tx.insert(productOptionValues).values(
          options.flatMap((option, index) =>
            option.values.map((name, valueIndex) => {
              const id = newId();
              valueIds[index]!.set(name.toLowerCase(), id);
              return {
                shopId: tenant.shopId,
                id,
                productId,
                optionId: optionRows[index]!.id,
                name,
                position: valueIndex + 1,
              };
            }),
          ),
        );
      }

      await tx.insert(variants).values(
        variantValues.map(({ fields, optionValues }, index) => {
          const ids = optionValues.map((name, position) =>
            valueIds[position]!.get(name.toLowerCase()),
          );
          return {
            shopId: tenant.shopId,
            id: newId(),
            productId,
            title: variantTitle(optionValues),
            sku: fields.sku ?? null,
            barcode: fields.barcode ?? null,
            price: fields.price ?? 0n,
            compareAtPrice: fields.compareAtPrice ?? null,
            cost: fields.cost ?? null,
            weightGrams: fields.weightGrams ?? null,
            position: index + 1,
            option1ValueId: ids[0] ?? null,
            option2ValueId: ids[1] ?? null,
            option3ValueId: ids[2] ?? null,
          };
        }),
      );

      await appendEvent<ProductCreatedPayload>(tx, tenant.shopId, {
        type: CatalogEvents.ProductCreated,
        aggregateType: 'product',
        aggregateId: productId,
        payload: {
          handle: product.handle,
          status: product.status,
          variantCount: variantValues.length,
        },
      });
      await refreshMemberships(tx, tenant, { productIds: [productId] });
      const record = await loadProduct(tx, tenant.shopId, productId);
      if (!record) throw new Error('Product disappeared after insert');
      return { ok: true, value: record };
    });
  }

  async update(
    tenant: TenantContext,
    input: UpdateProductInput,
  ): Promise<MutationResult<ProductRecord>> {
    const check = new InputChecker();
    const changes: Partial<
      Pick<
        ProductRow,
        'title' | 'handle' | 'description' | 'status' | 'vendor' | 'productType' | 'tags'
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
    if (input.status !== undefined) {
      if (input.status === null) check.add(['input', 'status'], 'BLANK', "can't be blank");
      else changes.status = input.status;
    }
    if (input.vendor !== undefined) {
      changes.vendor = check.text(['input', 'vendor'], input.vendor, { max: LIMITS.shortText });
    }
    if (input.productType !== undefined) {
      changes.productType = check.text(['input', 'productType'], input.productType, {
        max: LIMITS.shortText,
      });
    }
    if (input.tags !== undefined) changes.tags = check.tags(['input', 'tags'], input.tags);
    if (!check.ok) return fail(check.errors);

    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const current = await lockProduct(tx, tenant.shopId, input.id);
        if (!current) {
          return failOne<ProductRecord>(['input', 'id'], 'NOT_FOUND', 'Product not found');
        }

        const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter(
          (key) => JSON.stringify(changes[key]) !== JSON.stringify(current[key]),
        );
        if (changed.length > 0) {
          if (changed.includes('handle') && changes.handle) {
            const [taken] = await tx
              .select({ id: products.id })
              .from(products)
              .where(
                and(
                  eq(products.shopId, tenant.shopId),
                  eq(products.handle, changes.handle),
                  ne(products.id, current.id),
                ),
              );
            if (taken) {
              return failOne<ProductRecord>(
                ['input', 'handle'],
                'TAKEN',
                'Handle is already in use',
              );
            }
          }

          const next = { ...current, ...changes };
          const [updated] = await tx
            .update(products)
            .set({
              ...changes,
              searchText: searchTextOf(next),
              version: current.version + 1,
              updatedAt: sql`now()`,
            })
            .where(and(eq(products.shopId, tenant.shopId), eq(products.id, current.id)))
            .returning({ version: products.version });
          if (!updated) throw new Error('Product disappeared during update');

          await appendEvent<ProductUpdatedPayload>(tx, tenant.shopId, {
            type: CatalogEvents.ProductUpdated,
            aggregateType: 'product',
            aggregateId: current.id,
            payload: { changed, version: updated.version },
          });
          await refreshMemberships(tx, tenant, { productIds: [current.id] });
        }
        const record = await loadProduct(tx, tenant.shopId, current.id);
        if (!record) throw new Error('Product disappeared during update');
        return { ok: true, value: record };
      });
    } catch (error) {
      // Another request took the handle between our check and the update.
      if (isUniqueViolation(error)) {
        return failOne(['input', 'handle'], 'TAKEN', 'Handle is already in use');
      }
      throw error;
    }
  }

  /** Deletes a product with its variants, options and media, and takes it out of collections. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [deleted] = await tx
        .delete(products)
        .where(and(eq(products.shopId, tenant.shopId), eq(products.id, id)))
        .returning({ id: products.id, handle: products.handle });
      if (!deleted) return failOne(['input', 'id'], 'NOT_FOUND', 'Product not found');
      await appendEvent<ProductDeletedPayload>(tx, tenant.shopId, {
        type: CatalogEvents.ProductDeleted,
        aggregateType: 'product',
        aggregateId: deleted.id,
        payload: { handle: deleted.handle },
      });
      return { ok: true, value: { id: deleted.id } };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<ProductRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => loadProduct(tx, tenant.shopId, id));
  }

  async getByHandle(tenant: TenantContext, handle: string): Promise<ProductRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [record] = await loadProducts(tx, tenant.shopId, {
        where: sql`p.handle = ${handle}`,
      });
      return record ?? null;
    });
  }

  async list(tenant: TenantContext, options: ListProductsOptions): Promise<Page<ProductRecord>> {
    const conditions = [sql`true`];
    if (options.after) conditions.push(sql`p.id < ${options.after}`);
    // Every search token must appear. Tokens hold only letters and digits, so no LIKE escaping.
    for (const token of searchKey(options.query ?? '')
      .split(' ')
      .filter(Boolean)) {
      conditions.push(sql`p.search_text LIKE ${`%${token}%`}`);
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await loadProducts(tx, tenant.shopId, {
        where: sql.join(conditions, sql` AND `),
        order: sql`p.id DESC`,
        limit: options.first + 1,
      });
      return { items: rows.slice(0, options.first), hasNextPage: rows.length > options.first };
    });
  }

  /** Distinct tags, types or vendors in use, most used first, for pickers and filters. */
  async facetValues(tenant: TenantContext, facet: ProductFacet, first: number): Promise<string[]> {
    const column =
      facet === 'tags'
        ? sql`unnest(p.tags)`
        : facet === 'productType'
          ? sql`p.product_type`
          : sql`p.vendor`;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ value: string }>(sql`
        SELECT value FROM (SELECT ${column} AS value FROM catalog.products p
                            WHERE p.shop_id = ${tenant.shopId}) AS v
         WHERE value IS NOT NULL AND value <> ''
         GROUP BY value
         ORDER BY count(*) DESC, value
         LIMIT ${first}`);
      return rows.map((row) => row.value);
    });
  }

  /**
   * Products of the shop by ID, with their options, variants and media, in the caller's
   * transaction `tx`: for read models built outside the catalog, such as the storefront's. Those
   * not found are left out.
   */
  async recordsOf(tx: Tx, shopId: string, ids: readonly string[]): Promise<ProductRecord[]> {
    if (ids.length === 0) return [];
    return loadProducts(tx, shopId, {
      where: sql`p.id = ANY(${sql.param([...new Set(ids)])}::uuid[])`,
    });
  }

  /** The IDs of the shop's products, newest first, in the caller's transaction `tx`. */
  async idsOf(
    tx: Tx,
    shopId: string,
    options: { status?: ProductStatusValue } = {},
  ): Promise<string[]> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM catalog.products
       WHERE shop_id = ${shopId} ${options.status ? sql`AND status = ${options.status}` : sql``}
       ORDER BY id DESC`);
    return rows.map((row) => row.id);
  }

  /** Inserts unless the handle is taken, in which case it returns no rows. */
  private insertProduct(tx: Tx, values: typeof products.$inferInsert) {
    return tx
      .insert(products)
      .values(values)
      .onConflictDoNothing({ target: [products.shopId, products.handle] })
      .returning();
  }
}
