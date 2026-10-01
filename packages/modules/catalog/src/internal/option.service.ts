import type { TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  InputChecker,
  LIMITS,
  fail,
  failOne,
  isUniqueViolation,
  type MutationResult,
} from './input-checker.js';
import {
  loadForUpdate,
  loadProduct,
  productChanged,
  retitleVariants,
  variantTitle,
} from './product-store.js';
import type { ProductRecord } from './records.js';
import { productOptionValues, productOptions, variants } from './schema.js';
import {
  checkOptionInputs,
  checkValueNames,
  comboKey,
  combinations,
  type OptionInput,
} from './variant-input.js';

/** What to do with variants when options are added, like Shopify's variant strategies. */
export type NewOptionVariants = 'leave_as_is' | 'create';

export interface OptionUpdateInput {
  optionId: string;
  name?: string | null;
  /** New position, 1 to the number of options. */
  position?: number | null;
  valuesToAdd?: string[] | null;
  valuesToRename?: { id: string; name: string }[] | null;
  valuesToDelete?: string[] | null;
}

/**
 * The option columns of every variant of a product, rearranged: new column k takes old column
 * `from[k]` (a 0-based index), or NULL. One statement; the combination constraint is checked at
 * its end, so the shuffle cannot trip over itself.
 */
async function rearrangeOptionColumns(
  tx: Tx,
  shopId: string,
  productId: string,
  from: readonly (number | null)[],
): Promise<void> {
  const columns = [sql`v.option1_value_id`, sql`v.option2_value_id`, sql`v.option3_value_id`];
  const source = (k: number) => {
    const index = from[k];
    return index === null || index === undefined ? sql`NULL::uuid` : columns[index]!;
  };
  await tx.execute(sql`
    UPDATE catalog.variants v
       SET option1_value_id = ${source(0)},
           option2_value_id = ${source(1)},
           option3_value_id = ${source(2)},
           updated_at = now()
     WHERE v.shop_id = ${shopId} AND v.product_id = ${productId}`);
}

/** Writes option positions 1..n in the given order, in one statement. */
async function renumberOptions(
  tx: Tx,
  shopId: string,
  optionIds: readonly string[],
): Promise<void> {
  if (optionIds.length === 0) return;
  await tx.execute(sql`
    UPDATE catalog.product_options o
       SET position = u.position, updated_at = now()
      FROM unnest(${sql.param(optionIds)}::uuid[]) WITH ORDINALITY AS u(id, position)
     WHERE o.shop_id = ${shopId} AND o.id = u.id AND o.position <> u.position`);
}

/**
 * Product options and their values. A variant holds one value per option, in columns option1 to
 * option3 that follow the options' positions, so reordering or removing an option rearranges
 * every variant's columns in the same transaction.
 */
@Injectable()
export class OptionService {
  constructor(private readonly db: Database) {}

  /**
   * Adds options. Existing variants take each new option's first value; with `create`, variants
   * are also added for every combination that is missing, priced like the first variant.
   */
  async create(
    tenant: TenantContext,
    productId: string,
    inputs: OptionInput[],
    newVariants: NewOptionVariants = 'leave_as_is',
  ): Promise<MutationResult<ProductRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const check = new InputChecker();
      if (inputs.length === 0) check.add(['options'], 'BLANK', 'must include at least one');
      const shapes = checkOptionInputs(
        check,
        ['options'],
        inputs,
        product.options.map((option) => option.name),
      );
      if (!check.ok) return fail(check.errors);

      const all = [
        ...product.options.map((option) => ({
          name: option.name,
          values: option.values.map((value) => value.name),
        })),
        ...shapes,
      ];
      const existing = product.variants.map((variant) => [
        ...variant.selectedOptions.map((selected) => selected.value),
        ...shapes.map((shape) => shape.values[0]!),
      ]);
      const missing =
        newVariants === 'create'
          ? combinations(all).filter(
              (combo) => !existing.some((have) => comboKey(have) === comboKey(combo)),
            )
          : [];
      if (product.variants.length + missing.length > LIMITS.variants) {
        return failOne(
          ['options'],
          'TOO_MANY',
          `A product can have at most ${LIMITS.variants} variants; this would make ${
            product.variants.length + missing.length
          }`,
        );
      }

      const valueIds = new Map<string, string>();
      const key = (option: number, name: string) => `${option}:${name.toLowerCase()}`;
      product.options.forEach((option, index) =>
        option.values.forEach((value) => valueIds.set(key(index, value.name), value.id)),
      );
      const firstPosition = product.options.length + 1;
      const optionRows = shapes.map((shape, index) => ({
        shopId: tenant.shopId,
        id: newId(),
        productId,
        name: shape.name,
        position: firstPosition + index,
      }));
      await tx.insert(productOptions).values(optionRows);
      await tx.insert(productOptionValues).values(
        shapes.flatMap((shape, index) =>
          shape.values.map((name, valueIndex) => {
            const id = newId();
            valueIds.set(key(product.options.length + index, name), id);
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

      // Existing variants take the first value of each new option.
      const columns = [sql`option1_value_id`, sql`option2_value_id`, sql`option3_value_id`];
      const assignments = shapes.map(
        (shape, index) =>
          sql`${columns[product.options.length + index]!} = ${valueIds.get(
            key(product.options.length + index, shape.values[0]!),
          )!}::uuid`,
      );
      await tx.execute(sql`
        UPDATE catalog.variants
           SET ${sql.join(assignments, sql`, `)}, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND product_id = ${productId}`);

      if (missing.length > 0) {
        const template = product.variants[0]!;
        let position = Math.max(...product.variants.map((variant) => variant.position));
        await tx.insert(variants).values(
          missing.map((combo) => {
            const ids = combo.map((name, option) => valueIds.get(key(option, name)) ?? null);
            return {
              shopId: tenant.shopId,
              id: newId(),
              productId,
              title: variantTitle(combo),
              price: template.price,
              compareAtPrice: template.compareAtPrice,
              cost: template.cost,
              weightGrams: template.weightGrams,
              taxable: template.taxable,
              taxCode: template.taxCode,
              position: ++position,
              option1ValueId: ids[0] ?? null,
              option2ValueId: ids[1] ?? null,
              option3ValueId: ids[2] ?? null,
            };
          }),
        );
      }
      await retitleVariants(tx, tenant.shopId, productId);
      await productChanged(tx, tenant, productId, ['options', 'variants']);
      return { ok: true, value: (await loadProduct(tx, tenant.shopId, productId))! };
    });
  }

  /** Renames or moves one option, and adds, renames or deletes its values. */
  async update(
    tenant: TenantContext,
    productId: string,
    input: OptionUpdateInput,
  ): Promise<MutationResult<ProductRecord>> {
    try {
      return await this.updateInTransaction(tenant, productId, input);
    } catch (error) {
      // Two values swapping names pass the checks above but collide row by row in Postgres.
      if (isUniqueViolation(error)) {
        return failOne(
          ['optionValuesToUpdate'],
          'TAKEN',
          'Two values would have the same name at once; rename one of them in a separate step',
        );
      }
      throw error;
    }
  }

  private updateInTransaction(
    tenant: TenantContext,
    productId: string,
    input: OptionUpdateInput,
  ): Promise<MutationResult<ProductRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const index = product.options.findIndex((option) => option.id === input.optionId);
      const option = product.options[index];
      if (!option) return failOne(['option', 'id'], 'NOT_FOUND', 'The product has no such option');

      const check = new InputChecker();
      let name: string | null = null;
      if (input.name !== undefined && input.name !== null) {
        name = check.text(['option', 'name'], input.name, {
          required: true,
          max: LIMITS.shortText,
        });
        const clash = product.options.find(
          (other) => other.id !== option.id && other.name.toLowerCase() === name?.toLowerCase(),
        );
        if (clash) {
          check.addMessage(
            ['option', 'name'],
            'TAKEN',
            `The product already has an option named ${name}`,
          );
        }
      }
      const position = input.position ?? null;
      if (position !== null && (position < 1 || position > product.options.length)) {
        check.add(['option', 'position'], 'INVALID', `must be from 1 to ${product.options.length}`);
      }

      const valueById = new Map(option.values.map((value) => [value.id, value]));
      const toDelete = new Set<string>();
      (input.valuesToDelete ?? []).forEach((id, i) => {
        const value = valueById.get(id);
        if (!value) {
          check.addMessage(
            ['optionValuesToDelete', String(i)],
            'NOT_FOUND',
            'The option has no such value',
          );
        } else if (value.hasVariants) {
          check.addMessage(
            ['optionValuesToDelete', String(i)],
            'IN_USE',
            `Variants use ${value.name}; delete or change them first`,
          );
        } else {
          toDelete.add(id);
        }
      });
      const renames = new Map<string, string>();
      (input.valuesToRename ?? []).forEach((rename, i) => {
        if (!valueById.has(rename.id)) {
          check.addMessage(
            ['optionValuesToUpdate', String(i), 'id'],
            'NOT_FOUND',
            'The option has no such value',
          );
          return;
        }
        const newName = check.text(['optionValuesToUpdate', String(i), 'name'], rename.name, {
          required: true,
          max: LIMITS.shortText,
        });
        if (newName !== null) renames.set(rename.id, newName);
      });
      // Names after deletions and renames must stay unique, including the values being added.
      const kept = option.values
        .filter((value) => !toDelete.has(value.id))
        .map((value) => renames.get(value.id) ?? value.name);
      const keptLower = kept.map((value) => value.toLowerCase());
      if (new Set(keptLower).size !== keptLower.length) {
        check.addMessage(['optionValuesToUpdate'], 'TAKEN', 'Two values would have the same name');
      }
      const added = checkValueNames(check, ['optionValuesToAdd'], input.valuesToAdd ?? [], kept, {
        required: false,
      });
      if (kept.length + added.length === 0) {
        check.addMessage(['optionValuesToDelete'], 'TOO_FEW', 'An option needs at least one value');
      }
      if (!check.ok) return fail(check.errors);

      if (toDelete.size > 0) {
        await tx.execute(sql`
          DELETE FROM catalog.product_option_values
           WHERE shop_id = ${tenant.shopId} AND id = ANY(${sql.param([...toDelete])}::uuid[])`);
      }
      for (const [id, newName] of renames) {
        await tx.execute(sql`
          UPDATE catalog.product_option_values SET name = ${newName}, updated_at = now()
           WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      }
      if (added.length > 0) {
        let last = Math.max(0, ...option.values.map((value) => value.position));
        await tx.insert(productOptionValues).values(
          added.map((valueName) => ({
            shopId: tenant.shopId,
            id: newId(),
            productId,
            optionId: option.id,
            name: valueName,
            position: ++last,
          })),
        );
      }
      // Keep value positions 1..n after deletions.
      await tx.execute(sql`
        UPDATE catalog.product_option_values ov
           SET position = r.rank
          FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS rank
                  FROM catalog.product_option_values
                 WHERE shop_id = ${tenant.shopId} AND option_id = ${option.id}) r
         WHERE ov.shop_id = ${tenant.shopId} AND ov.id = r.id AND ov.position <> r.rank`);
      if (name !== null && name !== option.name) {
        await tx.execute(sql`
          UPDATE catalog.product_options SET name = ${name}, updated_at = now()
           WHERE shop_id = ${tenant.shopId} AND id = ${option.id}`);
      }
      if (position !== null && position !== option.position) {
        const order = product.options.map((other) => other.id);
        order.splice(index, 1);
        order.splice(position - 1, 0, option.id);
        const from = order.map((id) => product.options.findIndex((other) => other.id === id));
        await rearrangeOptionColumns(tx, tenant.shopId, productId, from);
        await renumberOptions(tx, tenant.shopId, order);
      }
      await retitleVariants(tx, tenant.shopId, productId);
      await productChanged(tx, tenant, productId, ['options', 'variants']);
      return { ok: true, value: (await loadProduct(tx, tenant.shopId, productId))! };
    });
  }

  /**
   * Deletes options. Refused when variants would then be indistinguishable, e.g. deleting Size
   * while both "S / Red" and "M / Red" exist: delete those variants first.
   */
  async delete(
    tenant: TenantContext,
    productId: string,
    optionIds: string[],
  ): Promise<MutationResult<{ product: ProductRecord; deletedIds: string[] }>> {
    if (optionIds.length === 0) {
      return failOne(['options'], 'BLANK', 'Options must include at least one');
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const product = await loadForUpdate(tx, tenant.shopId, productId);
      if (!product) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const check = new InputChecker();
      optionIds.forEach((id, i) => {
        if (!product.options.some((option) => option.id === id)) {
          check.addMessage(['options', String(i)], 'NOT_FOUND', 'The product has no such option');
        }
      });
      if (!check.ok) return fail(check.errors);

      const removed = new Set(optionIds);
      const keptIndexes = product.options
        .map((option, index) => (removed.has(option.id) ? null : index))
        .filter((index): index is number => index !== null);
      const remaining = product.variants.map((variant) =>
        comboKey(keptIndexes.map((index) => variant.selectedOptions[index]?.value ?? '')),
      );
      if (new Set(remaining).size !== remaining.length) {
        const names = product.options
          .filter((option) => removed.has(option.id))
          .map((option) => option.name)
          .join(', ');
        return failOne(
          ['options'],
          'INVALID',
          `Deleting ${names} would leave variants with the same options; delete those variants first`,
        );
      }

      await rearrangeOptionColumns(tx, tenant.shopId, productId, [
        keptIndexes[0] ?? null,
        keptIndexes[1] ?? null,
        keptIndexes[2] ?? null,
      ]);
      await tx.execute(sql`
        DELETE FROM catalog.product_options
         WHERE shop_id = ${tenant.shopId} AND id = ANY(${sql.param(optionIds)}::uuid[])`);
      await renumberOptions(
        tx,
        tenant.shopId,
        keptIndexes.map((index) => product.options[index]!.id),
      );
      await retitleVariants(tx, tenant.shopId, productId);
      await productChanged(tx, tenant, productId, ['options', 'variants']);
      return {
        ok: true,
        value: {
          product: (await loadProduct(tx, tenant.shopId, productId))!,
          deletedIds: [...removed],
        },
      };
    });
  }
}
