import type { TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { InputChecker, LIMITS, fail, failOne, type MutationResult } from './input-checker.js';
import {
  loadForUpdate,
  loadProduct,
  optionShapes,
  productChanged,
  retitleVariants,
  variantTitle,
} from './product-store.js';
import type { ProductRecord } from './records.js';
import { productOptionValues, products, variants, type ProductStatusValue } from './schema.js';
import {
  checkVariantFields,
  comboKey,
  resolveOptionValues,
  type VariantFields,
  type VariantFieldsInput,
} from './variant-input.js';

export interface VariantCreateInput extends VariantFieldsInput {
  /** One of the product's media, shown for this variant. */
  mediaId?: string | null;
}

export interface VariantUpdateInput extends VariantFieldsInput {
  id: string;
  /** null clears it. */
  mediaId?: string | null;
}

/** A variant as an order line records it. */
export interface VariantSnapshot {
  productId: string;
  productTitle: string;
  productStatus: ProductStatusValue;
  variantTitle: string;
  sku: string | null;
  /** Minor units in the shop currency. */
  price: bigint;
  weightGrams: number | null;
}

export interface VariantsResult {
  product: ProductRecord;
  /** The variants created or updated, in input order. */
  variantIds: string[];
}

/**
 * Adds values that combinations name but the options lack, after the existing ones. Returns, per
 * option, lowercased value name to id, or null when an option would exceed its value limit.
 */
export async function ensureOptionValues(
  tx: Tx,
  shopId: string,
  product: ProductRecord,
  combos: readonly (readonly string[])[],
  check: InputChecker,
  field: string[],
): Promise<{ ids: Map<string, string>[]; added: boolean } | null> {
  const ids = product.options.map(
    (option) => new Map(option.values.map((value) => [value.name.toLowerCase(), value.id])),
  );
  const rows: (typeof productOptionValues.$inferInsert)[] = [];
  for (const [index, option] of product.options.entries()) {
    let position = Math.max(0, ...option.values.map((value) => value.position));
    for (const combo of combos) {
      const name = combo[index];
      if (name === undefined || ids[index]!.has(name.toLowerCase())) continue;
      const id = newId();
      ids[index]!.set(name.toLowerCase(), id);
      rows.push({
        shopId,
        id,
        productId: product.id,
        optionId: option.id,
        name,
        position: ++position,
      });
    }
    if (ids[index]!.size > LIMITS.optionValues) {
      check.addMessage(
        field,
        'TOO_MANY',
        `${option.name} can have at most ${LIMITS.optionValues} values`,
      );
    }
  }
  if (!check.ok) return null;
  if (rows.length > 0) await tx.insert(productOptionValues).values(rows);
  return { ids, added: rows.length > 0 };
}

/**
 * Variants in bulk, like Shopify's productVariantsBulk* mutations. A product without options has
 * exactly one variant; options, such as Size, make room for more.
 */
@Injectable()
export class VariantService {
  constructor(private readonly db: Database) {}

  /**
   * The product of each of `variantIds` that is a variant in the shop; others are left out. For
   * other modules that must check variants inside their own tenant transaction `tx`.
   */
  async productIdsOf(
    tx: Tx,
    shopId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (variantIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: variants.id, productId: variants.productId })
      .from(variants)
      .where(and(eq(variants.shopId, shopId), inArray(variants.id, [...new Set(variantIds)])));
    return new Map(rows.map((row) => [row.id, row.productId]));
  }

  /**
   * What an order needs to know about each of `variantIds` in the shop: titles, SKU, price and
   * weight as they are now. Others are left out. Runs in the caller's tenant transaction `tx`.
   */
  async snapshotsOf(
    tx: Tx,
    shopId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, VariantSnapshot>> {
    if (variantIds.length === 0) return new Map();
    const rows = await tx
      .select({
        id: variants.id,
        productId: variants.productId,
        productTitle: products.title,
        productStatus: products.status,
        variantTitle: variants.title,
        sku: variants.sku,
        price: variants.price,
        weightGrams: variants.weightGrams,
      })
      .from(variants)
      .innerJoin(
        products,
        and(eq(products.shopId, variants.shopId), eq(products.id, variants.productId)),
      )
      .where(and(eq(variants.shopId, shopId), inArray(variants.id, [...new Set(variantIds)])));
    return new Map(rows.map(({ id, ...snapshot }) => [id, snapshot]));
  }

  async bulkCreate(
    tenant: TenantContext,
    productId: string,
    inputs: VariantCreateInput[],
  ): Promise<MutationResult<VariantsResult>> {
    const check = new InputChecker();
    if (inputs.length === 0) check.add(['variants'], 'BLANK', 'must include at least one');
    if (inputs.length > LIMITS.variants) {
      check.add(['variants'], 'TOO_MANY', `can have at most ${LIMITS.variants}`);
    }
    const fields = inputs.map((input, index) =>
      checkVariantFields(check, ['variants', String(index)], input, tenant.currency, {
        requirePrice: true,
      }),
    );
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      if (product.options.length === 0) {
        return failOne(
          ['variants'],
          'INVALID',
          'Add options, such as Size or Colour, before adding variants',
        );
      }
      if (product.variants.length + inputs.length > LIMITS.variants) {
        return failOne(
          ['variants'],
          'TOO_MANY',
          `A product can have at most ${LIMITS.variants} variants`,
        );
      }
      const shapes = optionShapes(product);
      const taken = new Set(
        product.variants.map((variant) =>
          comboKey(variant.selectedOptions.map((selected) => selected.value)),
        ),
      );
      const mediaIds = new Set(product.media.map((media) => media.id));
      const combos = inputs.map((input, index) => {
        const field = ['variants', String(index)];
        const combo = resolveOptionValues(
          check,
          [...field, 'optionValues'],
          fields[index]!.optionValues,
          shapes,
          true,
        );
        if (combo) {
          if (taken.has(comboKey(combo))) {
            check.addMessage(
              [...field, 'optionValues'],
              'TAKEN',
              `A variant with ${variantTitle(combo)} already exists`,
            );
          }
          taken.add(comboKey(combo));
        }
        if (input.mediaId && !mediaIds.has(input.mediaId)) {
          check.addMessage([...field, 'mediaId'], 'NOT_FOUND', 'The product has no such media');
        }
        return combo ?? [];
      });
      if (!check.ok) return fail(check.errors);

      const values = await ensureOptionValues(tx, tenant.shopId, product, combos, check, [
        'variants',
      ]);
      if (!values) return fail(check.errors);
      let position = Math.max(0, ...product.variants.map((variant) => variant.position));
      const rows = inputs.map((input, index) => {
        const combo = combos[index]!;
        const ids = combo.map((name, option) => values.ids[option]!.get(name.toLowerCase()));
        return {
          ...variantColumns(fields[index]!),
          shopId: tenant.shopId,
          id: newId(),
          productId,
          title: variantTitle(combo),
          price: fields[index]!.price ?? 0n,
          position: ++position,
          option1ValueId: ids[0] ?? null,
          option2ValueId: ids[1] ?? null,
          option3ValueId: ids[2] ?? null,
          mediaId: input.mediaId ?? null,
        };
      });
      await tx.insert(variants).values(rows);
      await productChanged(
        tx,
        tenant,
        productId,
        values.added ? ['options', 'variants'] : ['variants'],
      );
      const record = await loadProduct(tx, tenant.shopId, productId);
      return { ok: true, value: { product: record!, variantIds: rows.map((row) => row.id) } };
    });
  }

  async bulkUpdate(
    tenant: TenantContext,
    productId: string,
    inputs: VariantUpdateInput[],
  ): Promise<MutationResult<VariantsResult>> {
    const check = new InputChecker();
    if (inputs.length === 0) check.add(['variants'], 'BLANK', 'must include at least one');
    if (inputs.length > LIMITS.variants) {
      check.add(['variants'], 'TOO_MANY', `can have at most ${LIMITS.variants}`);
    }
    const seenIds = new Set<string>();
    const fields = inputs.map((input, index) => {
      if (seenIds.has(input.id)) {
        check.addMessage(['variants', String(index), 'id'], 'INVALID', 'Variant is listed twice');
      }
      seenIds.add(input.id);
      return checkVariantFields(check, ['variants', String(index)], input, tenant.currency, {
        requirePrice: false,
      });
    });
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const shapes = optionShapes(product);
      const mediaIds = new Set(product.media.map((media) => media.id));
      // Every variant's combination after the update, to check they stay unique.
      const finalCombos = new Map(
        product.variants.map((variant) => [
          variant.id,
          variant.selectedOptions.map((selected) => selected.value),
        ]),
      );
      const changedCombos = new Map<string, string[]>();
      inputs.forEach((input, index) => {
        const field = ['variants', String(index)];
        if (!finalCombos.has(input.id)) {
          check.addMessage([...field, 'id'], 'NOT_FOUND', 'The product has no such variant');
          return;
        }
        const optionValues = fields[index]!.optionValues;
        if (optionValues !== undefined) {
          const combo = resolveOptionValues(
            check,
            [...field, 'optionValues'],
            optionValues,
            shapes,
            true,
          );
          if (combo) {
            finalCombos.set(input.id, combo);
            changedCombos.set(input.id, combo);
          }
        }
        if (input.mediaId && !mediaIds.has(input.mediaId)) {
          check.addMessage([...field, 'mediaId'], 'NOT_FOUND', 'The product has no such media');
        }
      });
      const owners = new Map<string, string>();
      for (const [variantId, combo] of finalCombos) {
        const key = comboKey(combo);
        const other = owners.get(key);
        if (other !== undefined) {
          const index = inputs.findIndex(
            (input) =>
              changedCombos.has(input.id) && (input.id === variantId || input.id === other),
          );
          check.addMessage(
            ['variants', String(Math.max(index, 0)), 'optionValues'],
            'TAKEN',
            `Two variants would both be ${variantTitle(combo)}`,
          );
        }
        owners.set(key, variantId);
      }
      if (!check.ok) return fail(check.errors);

      const values = await ensureOptionValues(
        tx,
        tenant.shopId,
        product,
        [...changedCombos.values()],
        check,
        ['variants'],
      );
      if (!values) return fail(check.errors);

      // One statement for the whole batch. The combination constraint is checked at its end, so
      // two variants can swap combinations.
      const rows = inputs.map((input, index) => {
        const f = fields[index]!;
        const combo = changedCombos.get(input.id);
        const ids = combo?.map((name, option) => values.ids[option]!.get(name.toLowerCase())) ?? [];
        const text = (value: string | null | undefined) => sql`${value ?? null}::text`;
        const amount = (value: bigint | null | undefined) =>
          sql`${value === undefined || value === null ? null : value.toString()}::bigint`;
        return sql`(${input.id}::uuid,
          ${f.price !== undefined}::boolean, ${amount(f.price)},
          ${f.compareAtPrice !== undefined}::boolean, ${amount(f.compareAtPrice)},
          ${f.cost !== undefined}::boolean, ${amount(f.cost)},
          ${f.sku !== undefined}::boolean, ${text(f.sku)},
          ${f.barcode !== undefined}::boolean, ${text(f.barcode)},
          ${f.weightGrams !== undefined}::boolean, ${f.weightGrams ?? null}::integer,
          ${input.mediaId !== undefined}::boolean, ${input.mediaId ?? null}::uuid,
          ${combo !== undefined}::boolean,
          ${ids[0] ?? null}::uuid, ${ids[1] ?? null}::uuid, ${ids[2] ?? null}::uuid)`;
      });
      await tx.execute(sql`
        UPDATE catalog.variants v
           SET price = CASE WHEN u.set_price THEN u.price ELSE v.price END,
               compare_at_price = CASE WHEN u.set_compare THEN u.compare_at ELSE v.compare_at_price END,
               cost = CASE WHEN u.set_cost THEN u.cost ELSE v.cost END,
               sku = CASE WHEN u.set_sku THEN u.sku ELSE v.sku END,
               barcode = CASE WHEN u.set_barcode THEN u.barcode ELSE v.barcode END,
               weight_grams = CASE WHEN u.set_weight THEN u.weight ELSE v.weight_grams END,
               media_id = CASE WHEN u.set_media THEN u.media ELSE v.media_id END,
               option1_value_id = CASE WHEN u.set_options THEN u.o1 ELSE v.option1_value_id END,
               option2_value_id = CASE WHEN u.set_options THEN u.o2 ELSE v.option2_value_id END,
               option3_value_id = CASE WHEN u.set_options THEN u.o3 ELSE v.option3_value_id END,
               updated_at = now()
          FROM (VALUES ${sql.join(rows, sql`, `)})
            AS u(id, set_price, price, set_compare, compare_at, set_cost, cost, set_sku, sku,
                 set_barcode, barcode, set_weight, weight, set_media, media, set_options,
                 o1, o2, o3)
         WHERE v.shop_id = ${tenant.shopId} AND v.product_id = ${productId} AND v.id = u.id`);
      if (changedCombos.size > 0) await retitleVariants(tx, tenant.shopId, productId);
      await productChanged(
        tx,
        tenant,
        productId,
        values.added ? ['options', 'variants'] : ['variants'],
      );
      const record = await loadProduct(tx, tenant.shopId, productId);
      return { ok: true, value: { product: record!, variantIds: inputs.map((input) => input.id) } };
    });
  }

  async bulkDelete(
    tenant: TenantContext,
    productId: string,
    variantIds: string[],
  ): Promise<MutationResult<ProductRecord>> {
    if (variantIds.length === 0) {
      return failOne(['variantsIds'], 'BLANK', 'Variants ids must include at least one');
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const known = new Set(product.variants.map((variant) => variant.id));
      const check = new InputChecker();
      variantIds.forEach((id, index) => {
        if (!known.has(id)) {
          check.addMessage(
            ['variantsIds', String(index)],
            'NOT_FOUND',
            'The product has no such variant',
          );
        }
      });
      if (!check.ok) return fail(check.errors);
      if (new Set(variantIds).size >= product.variants.length) {
        return failOne(['variantsIds'], 'TOO_FEW', 'A product needs at least one variant');
      }
      await tx.execute(sql`
        DELETE FROM catalog.variants
         WHERE shop_id = ${tenant.shopId} AND product_id = ${productId}
           AND id = ANY(${sql.param(variantIds)}::uuid[])`);
      await tx.execute(sql`
        UPDATE catalog.variants v
           SET position = r.rank
          FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS rank
                  FROM catalog.variants
                 WHERE shop_id = ${tenant.shopId} AND product_id = ${productId}) r
         WHERE v.shop_id = ${tenant.shopId} AND v.id = r.id AND v.position <> r.rank`);
      await productChanged(tx, tenant, productId, ['variants']);
      const record = await loadProduct(tx, tenant.shopId, productId);
      return { ok: true, value: record! };
    });
  }
}

/** Insert values for the optional variant fields. */
function variantColumns(fields: VariantFields) {
  return {
    sku: fields.sku ?? null,
    barcode: fields.barcode ?? null,
    compareAtPrice: fields.compareAtPrice ?? null,
    cost: fields.cost ?? null,
    weightGrams: fields.weightGrams ?? null,
  };
}
