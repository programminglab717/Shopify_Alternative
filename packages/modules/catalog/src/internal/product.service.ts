import { randomBytes } from 'node:crypto';
import type { TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { fromMajor, type CurrencyCode } from '@hatti/money';
import { searchKey } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, like, lt, ne, sql } from 'drizzle-orm';
import { CatalogEvents, type ProductCreatedPayload, type ProductUpdatedPayload } from './events.js';
import { handleCandidate, toHandle } from './handle.js';
import {
  products,
  variants,
  type ProductRow,
  type ProductStatusValue,
  type VariantRow,
} from './schema.js';

export interface VariantRecord {
  id: string;
  productId: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  /** Minor units in the shop currency. */
  price: bigint;
  compareAtPrice: bigint | null;
  position: number;
}

export interface ProductRecord {
  id: string;
  title: string;
  handle: string;
  status: ProductStatusValue;
  description: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
  variants: VariantRecord[];
}

export interface VariantInput {
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
  /** Decimal in major units of the shop currency, e.g. "2499" or "2,499.50". */
  price: string;
  compareAtPrice?: string | null;
}

export interface CreateProductInput {
  title: string;
  handle?: string | null;
  description?: string | null;
  status?: ProductStatusValue | null;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[] | null;
  /** Defaults to one variant priced at zero. */
  variants?: VariantInput[] | null;
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

export type FieldErrorCode = 'BLANK' | 'TOO_LONG' | 'TOO_MANY' | 'INVALID' | 'TAKEN' | 'NOT_FOUND';

export interface FieldError {
  field: string[];
  code: FieldErrorCode;
  message: string;
}

export type MutationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

export interface ListProductsOptions {
  first: number;
  /** Return products created before this one (UUID); pages run newest first. */
  after?: string | null;
  /** Free-text search over title, vendor, type and tags. */
  query?: string | null;
}

const LIMITS = {
  title: 255,
  description: 100_000,
  shortText: 255,
  tags: 250,
  variants: 100,
  handleAttempts: 20,
} as const;

function fail<T>(errors: FieldError[]): MutationResult<T> {
  return { ok: false, errors };
}

/** "productType" → "Product type", for messages like "Product type is too long". */
function humanize(name: string): string {
  const words = name.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Collects field errors while normalising input. */
class InputChecker {
  readonly errors: FieldError[] = [];

  text(
    field: string[],
    value: string | null | undefined,
    options: { required?: boolean; max: number },
  ): string | null {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length === 0) {
      if (options.required) this.add(field, 'BLANK', "can't be blank");
      return null;
    }
    if (trimmed.length > options.max) {
      this.add(field, 'TOO_LONG', `is too long (maximum is ${options.max} characters)`);
    }
    return trimmed;
  }

  tags(field: string[], value: string[] | null | undefined): string[] {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const raw of value ?? []) {
      const tag = raw.trim();
      if (tag.length === 0 || seen.has(tag.toLowerCase())) continue;
      if (tag.length > LIMITS.shortText) {
        this.add(field, 'TOO_LONG', `contain a tag longer than ${LIMITS.shortText} characters`);
      }
      seen.add(tag.toLowerCase());
      tags.push(tag);
    }
    if (tags.length > LIMITS.tags) this.add(field, 'TOO_MANY', `can have at most ${LIMITS.tags}`);
    return tags;
  }

  handle(field: string[], value: string): string | null {
    const handle = toHandle(value);
    if (!handle) this.add(field, 'INVALID', 'must contain letters or digits');
    return handle || null;
  }

  price(
    field: string[],
    value: string | null | undefined,
    currency: CurrencyCode,
    options: { required?: boolean } = {},
  ): bigint | null {
    if (value === null || value === undefined || value.trim() === '') {
      if (options.required) this.add(field, 'BLANK', "can't be blank");
      return null;
    }
    try {
      const amount = fromMajor(value.trim(), currency).amount;
      if (amount < 0n) throw new RangeError('negative');
      return amount;
    } catch {
      this.add(field, 'INVALID', 'must be an amount of zero or more, like 2499 or 2499.50');
      return null;
    }
  }

  add(field: string[], code: FieldErrorCode, message: string): void {
    this.errors.push({
      field,
      code,
      message: `${humanize(field[field.length - 1] ?? 'input')} ${message}`,
    });
  }
}

function toVariantRecord(row: VariantRow): VariantRecord {
  return {
    id: row.id,
    productId: row.productId,
    title: row.title,
    sku: row.sku,
    barcode: row.barcode,
    price: row.price,
    compareAtPrice: row.compareAtPrice,
    position: row.position,
  };
}

function toProductRecord(row: ProductRow, variantRows: VariantRow[]): ProductRecord {
  return {
    id: row.id,
    title: row.title,
    handle: row.handle,
    status: row.status,
    description: row.description,
    vendor: row.vendor,
    productType: row.productType,
    tags: row.tags,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    variants: variantRows.map(toVariantRecord),
  };
}

/** Search key over the searchable fields; see searchKey() in @hatti/pk. */
function searchTextOf(fields: {
  title: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
}): string {
  return searchKey([fields.title, fields.vendor, fields.productType, ...fields.tags].join(' '));
}

function isUniqueViolation(error: unknown): boolean {
  const err = error as { code?: string; cause?: { code?: string } };
  return (err.code ?? err.cause?.code) === '23505';
}

/**
 * Products and their variants. Every method runs in a tenant transaction for the caller's shop,
 * and also filters by shop explicitly, so isolation holds even if row-level security were off.
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

    const variantInputs = input.variants ?? [{ price: '0' }];
    if (variantInputs.length === 0) {
      check.add(['input', 'variants'], 'BLANK', 'must include at least one');
    }
    if (variantInputs.length > LIMITS.variants) {
      check.add(['input', 'variants'], 'TOO_MANY', `can have at most ${LIMITS.variants}`);
    }
    const variantValues = variantInputs.map((variant, index) => {
      const field = (name: string) => ['input', 'variants', String(index), name];
      return {
        title: check.text(field('title'), variant.title, { max: LIMITS.shortText }) ?? 'Default',
        sku: check.text(field('sku'), variant.sku, { max: LIMITS.shortText }),
        barcode: check.text(field('barcode'), variant.barcode, { max: LIMITS.shortText }),
        price:
          check.price(field('price'), variant.price, tenant.currency, { required: true }) ?? 0n,
        compareAtPrice: check.price(
          field('compareAtPrice'),
          variant.compareAtPrice,
          tenant.currency,
        ),
        position: index + 1,
      };
    });
    if (check.errors.length > 0 || title === null) return fail(check.errors);

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
          return fail<ProductRecord>([
            { field: ['input', 'handle'], code: 'TAKEN', message: 'Handle is already in use' },
          ]);
        }
      }
      // Very common titles: fall back to a random suffix.
      if (!product) {
        const handle = `${base.slice(0, 80)}-${randomBytes(3).toString('hex')}`;
        [product] = await this.insertProduct(tx, { ...values, handle });
      }
      if (!product) throw new Error('Could not allocate a product handle');

      const variantRows = await tx
        .insert(variants)
        .values(
          variantValues.map((variant) => ({
            ...variant,
            shopId: tenant.shopId,
            id: newId(),
            productId,
          })),
        )
        .returning();

      await appendEvent<ProductCreatedPayload>(tx, tenant.shopId, {
        type: CatalogEvents.ProductCreated,
        aggregateType: 'product',
        aggregateId: productId,
        payload: {
          handle: product.handle,
          status: product.status,
          variantCount: variantRows.length,
        },
      });
      return { ok: true, value: toProductRecord(product, variantRows) };
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
    if (check.errors.length > 0) return fail(check.errors);

    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const [current] = await tx
          .select()
          .from(products)
          .where(and(eq(products.shopId, tenant.shopId), eq(products.id, input.id)))
          .for('update');
        if (!current) {
          return fail<ProductRecord>([
            { field: ['input', 'id'], code: 'NOT_FOUND', message: 'Product not found' },
          ]);
        }

        const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter(
          (key) => JSON.stringify(changes[key]) !== JSON.stringify(current[key]),
        );
        if (changed.length === 0) {
          return {
            ok: true,
            value: toProductRecord(current, await this.variantsOf(tx, tenant, [current.id])),
          };
        }

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
            return fail<ProductRecord>([
              { field: ['input', 'handle'], code: 'TAKEN', message: 'Handle is already in use' },
            ]);
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
          .returning();
        if (!updated) throw new Error('Product disappeared during update');

        await appendEvent<ProductUpdatedPayload>(tx, tenant.shopId, {
          type: CatalogEvents.ProductUpdated,
          aggregateType: 'product',
          aggregateId: updated.id,
          payload: { changed, version: updated.version },
        });
        return {
          ok: true,
          value: toProductRecord(updated, await this.variantsOf(tx, tenant, [updated.id])),
        };
      });
    } catch (error) {
      // Another request took the handle between our check and the update.
      if (isUniqueViolation(error)) {
        return fail([
          { field: ['input', 'handle'], code: 'TAKEN', message: 'Handle is already in use' },
        ]);
      }
      throw error;
    }
  }

  async get(tenant: TenantContext, id: string): Promise<ProductRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(products)
        .where(and(eq(products.shopId, tenant.shopId), eq(products.id, id)));
      return row ? toProductRecord(row, await this.variantsOf(tx, tenant, [row.id])) : null;
    });
  }

  async list(
    tenant: TenantContext,
    options: ListProductsOptions,
  ): Promise<{ items: ProductRecord[]; hasNextPage: boolean }> {
    const conditions = [eq(products.shopId, tenant.shopId)];
    if (options.after) conditions.push(lt(products.id, options.after));
    // Every search token must appear. Tokens hold only letters and digits, so no LIKE escaping.
    for (const token of searchKey(options.query ?? '')
      .split(' ')
      .filter(Boolean)) {
      conditions.push(like(products.searchText, `%${token}%`));
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(products)
        .where(and(...conditions))
        .orderBy(desc(products.id))
        .limit(options.first + 1);
      const page = rows.slice(0, options.first);
      const variantRows = await this.variantsOf(
        tx,
        tenant,
        page.map((row) => row.id),
      );
      return {
        items: page.map((row) =>
          toProductRecord(
            row,
            variantRows.filter((variant) => variant.productId === row.id),
          ),
        ),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /** Inserts unless the handle is taken, in which case it returns no rows. */
  private insertProduct(tx: Tx, values: typeof products.$inferInsert) {
    return tx
      .insert(products)
      .values(values)
      .onConflictDoNothing({ target: [products.shopId, products.handle] })
      .returning();
  }

  private async variantsOf(
    tx: Tx,
    tenant: TenantContext,
    productIds: string[],
  ): Promise<VariantRow[]> {
    if (productIds.length === 0) return [];
    return tx
      .select()
      .from(variants)
      .where(and(eq(variants.shopId, tenant.shopId), inArray(variants.productId, productIds)))
      .orderBy(asc(variants.productId), asc(variants.position));
  }
}
