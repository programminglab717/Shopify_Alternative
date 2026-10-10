import {
  InputChecker,
  UserErrorsRollback,
  failOne,
  rollbackResult,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, appendEvents } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { InventoryEvents, type InventoryItemUpdatedPayload } from './events.js';
import { availableForSale, loadItems, sellableQuantity, untrackedItem } from './item-store.js';
import {
  ensureItems,
  ensureLevels,
  levelKey,
  lockLevels,
  writeChanges,
  type LevelChange,
  type LockedLevel,
} from './level-store.js';
import { locationFromJson, type LocationJson } from './location-store.js';
import type {
  AdjustmentGroupRecord,
  InventoryChangeRecord,
  InventoryItemRecord,
  Page,
} from './records.js';
import {
  ADJUSTMENT_REASONS,
  LIMITS,
  MOVE_REASONS,
  SETTABLE_NAMES,
  isDocumentUri,
  type SettableName,
} from './rules.js';
import { items, locations, type InventoryPolicyValue, type QuantityName } from './schema.js';

export interface InventoryChangeInput {
  /** The variant whose stock changes. */
  inventoryItemId: string;
  locationId: string;
  /** Units to add; negative removes. */
  delta: number;
}

export interface AdjustQuantitiesInput {
  /** "available", "on_hand" or "safety_stock". */
  name: string;
  /** One of {@link ADJUSTMENT_REASONS}. */
  reason: string;
  referenceDocumentUri?: string | null;
  changes: InventoryChangeInput[];
}

export interface InventoryQuantityInput {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  /** When given, the quantity is set only if it is still this; otherwise a STALE error. */
  compareQuantity?: number | null;
}

export interface SetQuantitiesInput {
  name: string;
  reason: string;
  referenceDocumentUri?: string | null;
  quantities: InventoryQuantityInput[];
}

/** One end of a move: where stock leaves or arrives, and which quantity. */
export interface MoveTerminalInput {
  locationId: string;
  /** Only "available", as Hatti has no other quantity stock can move between. */
  name: string;
}

export interface InventoryMoveInput {
  inventoryItemId: string;
  /** Units to move, 1 or more. */
  quantity: number;
  from: MoveTerminalInput;
  to: MoveTerminalInput;
}

export interface MoveQuantitiesInput {
  /** One of {@link MOVE_REASONS}. */
  reason: string;
  referenceDocumentUri?: string | null;
  changes: InventoryMoveInput[];
}

export interface InventoryItemUpdateInput {
  tracked?: boolean | null;
  inventoryPolicy?: InventoryPolicyValue | null;
}

export interface HistoryOptions {
  first: number;
  /** The last change of the previous page. */
  after?: string | null;
  locationId?: string | null;
}

/** An item and location named by one entry of a request, and where to report problems. */
interface Target {
  variantId: string;
  locationId: string;
  field: string[];
  /** Where an unknown item is reported, when not at `field`. */
  itemField?: string[];
}

interface Header {
  name: SettableName;
  reason: string;
  referenceDocumentUri: string | null;
}

function checkHeader(check: InputChecker, input: AdjustQuantitiesInput | SetQuantitiesInput) {
  const name = (SETTABLE_NAMES as readonly string[]).includes(input.name)
    ? (input.name as SettableName)
    : null;
  if (!name) {
    check.add(['input', 'name'], 'INVALID', `must be one of: ${SETTABLE_NAMES.join(', ')}`);
  }
  const reason = (ADJUSTMENT_REASONS as readonly string[]).includes(input.reason)
    ? input.reason
    : null;
  if (!reason) {
    check.add(['input', 'reason'], 'INVALID', `must be one of: ${ADJUSTMENT_REASONS.join(', ')}`);
  }
  const referenceDocumentUri = checkUri(check, input.referenceDocumentUri);
  return name && reason ? { name, reason, referenceDocumentUri } : null;
}

function checkUri(check: InputChecker, value: string | null | undefined): string | null {
  const field = ['input', 'referenceDocumentUri'];
  const uri = check.text(field, value, { max: LIMITS.uri });
  if (uri !== null && !isDocumentUri(uri)) {
    check.add(field, 'INVALID', 'must be a URI with a scheme, like https://… or hatti://…');
  }
  return uri;
}

function checkCount(check: InputChecker, listField: string[], count: number): void {
  if (count === 0) check.add(listField, 'BLANK', 'must include at least one');
  if (count > LIMITS.changes) {
    check.add(listField, 'TOO_MANY', `can have at most ${LIMITS.changes}`);
  }
}

function checkTargets(check: InputChecker, listField: string[], targets: readonly Target[]): void {
  checkCount(check, listField, targets.length);
  checkRepeats(check, targets);
}

/** Refuses a level named twice: one write can change each level once. */
function checkRepeats(check: InputChecker, targets: readonly Target[]): void {
  const seen = new Set<string>();
  for (const target of targets) {
    const key = levelKey(target.variantId, target.locationId);
    if (seen.has(key)) {
      check.addMessage(target.field, 'INVALID', 'The same item and location are listed twice');
    }
    seen.add(key);
  }
}

/** The quantity a request reads or sets. */
function current(level: LockedLevel, name: SettableName): number {
  if (name === 'available') return level.available;
  return name === 'on_hand' ? level.onHand : level.safetyStock;
}

/**
 * Checks a level's quantities after a change of `delta` to `name`, and returns the change, or
 * null after adding an error at `field`.
 */
function levelChange(
  errors: FieldError[],
  field: string[],
  level: LockedLevel,
  name: SettableName,
  delta: number,
): LevelChange | null {
  const change = { level, onHand: 0, committed: 0, reserved: 0, safetyStock: 0 };
  if (name === 'safety_stock') {
    const after = level.safetyStock + delta;
    if (after < 0 || after > LIMITS.quantity) {
      errors.push({
        field,
        code: 'INVALID',
        message: `Safety stock would be ${after}; it must be from 0 to ${LIMITS.quantity}`,
      });
      return null;
    }
    return { ...change, safetyStock: delta };
  }
  const after = level.onHand + delta;
  if (delta < 0 && after < 0) {
    errors.push({
      field,
      code: 'INVALID',
      message: `Only ${level.onHand} on hand at this location; can't remove ${-delta}`,
    });
    return null;
  }
  if (after > LIMITS.quantity) {
    errors.push({
      field,
      code: 'INVALID',
      message: `On hand would be ${after}; the most is ${LIMITS.quantity}`,
    });
    return null;
  }
  return { ...change, onHand: delta };
}

/**
 * Stock as merchants and apps see it: each variant's item and its levels, stock counts and
 * adjustments, and the history of every change. Checkouts and orders change stock through
 * {@link StockService} instead.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
  ) {}

  /** The items of those of `variantIds` whose stock was ever recorded; for batch loaders. */
  itemsOf(tenant: TenantContext, variantIds: readonly string[]) {
    if (variantIds.length === 0) return Promise.resolve(new Map<string, InventoryItemRecord>());
    return this.db.tenant(tenant.shopId, (tx) => loadItems(tx, tenant.shopId, variantIds));
  }

  /**
   * Whether stock allows selling each of `variantIds` online, in the caller's transaction `tx`:
   * for read models built outside inventory, such as the storefront's. A variant whose stock
   * was never recorded can be sold.
   */
  async availableOf(
    tx: Tx,
    shopId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, boolean>> {
    const loaded = await loadItems(tx, shopId, variantIds);
    return new Map(
      variantIds.map((id) => [id, availableForSale(loaded.get(id) ?? untrackedItem(id))]),
    );
  }

  /**
   * How many of each of `variantIds` can be sold online now, in the caller's transaction `tx`:
   * for carts, kept outside inventory. Null for no limit, when stock is not tracked or the variant
   * sells on at zero.
   */
  async sellableOf(
    tx: Tx,
    shopId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, number | null>> {
    const loaded = await loadItems(tx, shopId, variantIds);
    return new Map(
      variantIds.map((id) => {
        const item = loaded.get(id) ?? untrackedItem(id);
        const unlimited = !item.tracked || item.inventoryPolicy === 'continue';
        return [id, unlimited ? null : Math.max(0, sellableQuantity(item))];
      }),
    );
  }

  /** The item of a variant, or null if the shop has no such variant. */
  async item(tenant: TenantContext, variantId: string): Promise<InventoryItemRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const products = await this.variants.productIdsOf(tx, tenant.shopId, [variantId]);
      if (!products.has(variantId)) return null;
      const loaded = await loadItems(tx, tenant.shopId, [variantId]);
      return loaded.get(variantId) ?? untrackedItem(variantId);
    });
  }

  /** Turns tracking on or off, or changes what happens at zero available. */
  async updateItem(
    tenant: TenantContext,
    variantId: string,
    input: InventoryItemUpdateInput,
  ): Promise<MutationResult<InventoryItemRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const products = await this.variants.productIdsOf(tx, tenant.shopId, [variantId]);
      const productId = products.get(variantId);
      if (!productId) return failOne(['id'], 'NOT_FOUND', 'Inventory item not found');

      const [existing] = await tx
        .select()
        .from(items)
        .where(and(eq(items.shopId, tenant.shopId), eq(items.variantId, variantId)))
        .for('update');
      const before = existing ?? { tracked: false, inventoryPolicy: 'deny' as const, version: 0 };
      const tracked = input.tracked ?? before.tracked;
      const inventoryPolicy = input.inventoryPolicy ?? before.inventoryPolicy;
      const changed: InventoryItemUpdatedPayload['changed'] = [];
      if (tracked !== before.tracked) changed.push('tracked');
      if (inventoryPolicy !== before.inventoryPolicy) changed.push('inventoryPolicy');

      if (changed.length > 0) {
        const [written] = existing
          ? await tx
              .update(items)
              .set({
                tracked,
                inventoryPolicy,
                version: sql`${items.version} + 1`,
                updatedAt: sql`now()`,
              })
              .where(and(eq(items.shopId, tenant.shopId), eq(items.variantId, variantId)))
              .returning({ version: items.version })
          : await tx
              .insert(items)
              .values({ shopId: tenant.shopId, variantId, productId, tracked, inventoryPolicy })
              .returning({ version: items.version });
        await appendEvent<InventoryItemUpdatedPayload>(tx, tenant.shopId, {
          type: InventoryEvents.InventoryItemUpdated,
          aggregateType: 'inventory_item',
          aggregateId: variantId,
          payload: { productId, changed, tracked, inventoryPolicy, version: written!.version },
        });
      }
      const loaded = await loadItems(tx, tenant.shopId, [variantId]);
      return { ok: true, value: loaded.get(variantId) ?? untrackedItem(variantId) };
    });
  }

  /**
   * Adds to or takes from quantities, like Shopify's inventoryAdjustQuantities: a delivery
   * received, damaged goods written off. All changes apply, or none. The result is null when
   * nothing changed.
   */
  async adjustQuantities(
    tenant: TenantContext,
    input: AdjustQuantitiesInput,
  ): Promise<MutationResult<AdjustmentGroupRecord | null>> {
    const check = new InputChecker();
    const header = checkHeader(check, input);
    const targets = input.changes.map((change, index) => ({
      variantId: change.inventoryItemId,
      locationId: change.locationId,
      field: ['input', 'changes', String(index)],
      delta: change.delta,
    }));
    checkTargets(check, ['input', 'changes'], targets);
    for (const target of targets) {
      const field = [...target.field, 'delta'];
      const delta = check.integer(field, target.delta, {
        min: -LIMITS.quantity,
        max: LIMITS.quantity,
      });
      if (delta === 0) check.add(field, 'INVALID', "can't be zero");
    }
    if (!check.ok || !header) return { ok: false, errors: check.errors };

    return this.#change(tenant, header, targets, (level, target, errors) =>
      levelChange(errors, [...target.field, 'delta'], level, header.name, target.delta),
    );
  }

  /**
   * Sets quantities, like Shopify's inventorySetQuantities: a stock count. With a compare
   * quantity, a level that changed since it was read is left alone and reported as STALE. All
   * quantities are set, or none. The result is null when nothing changed.
   */
  async setQuantities(
    tenant: TenantContext,
    input: SetQuantitiesInput,
  ): Promise<MutationResult<AdjustmentGroupRecord | null>> {
    const check = new InputChecker();
    const header = checkHeader(check, input);
    const targets = input.quantities.map((entry, index) => ({
      variantId: entry.inventoryItemId,
      locationId: entry.locationId,
      field: ['input', 'quantities', String(index)],
      quantity: entry.quantity,
      compareQuantity: entry.compareQuantity ?? null,
    }));
    checkTargets(check, ['input', 'quantities'], targets);
    for (const target of targets) {
      check.integer([...target.field, 'quantity'], target.quantity, {
        min: 0,
        max: LIMITS.quantity,
      });
      check.integer([...target.field, 'compareQuantity'], target.compareQuantity, {
        min: -4 * LIMITS.quantity,
        max: LIMITS.quantity,
      });
    }
    if (!check.ok || !header) return { ok: false, errors: check.errors };

    return this.#change(tenant, header, targets, (level, target, errors) => {
      const now = current(level, header.name);
      if (target.compareQuantity !== null && target.compareQuantity !== now) {
        errors.push({
          field: [...target.field, 'compareQuantity'],
          code: 'STALE',
          message: `The quantity is ${now} now, not ${target.compareQuantity}; read it again`,
        });
        return null;
      }
      return levelChange(
        errors,
        [...target.field, 'quantity'],
        level,
        header.name,
        target.quantity - now,
      );
    });
  }

  /**
   * Moves stock between locations, like Shopify's inventoryMoveQuantities: goods sent from a
   * warehouse to a shop. Each move takes from one location's on hand what is available there and
   * adds it to the other's, in one adjustment. All moves apply, or none.
   */
  async moveQuantities(
    tenant: TenantContext,
    input: MoveQuantitiesInput,
  ): Promise<MutationResult<AdjustmentGroupRecord | null>> {
    const check = new InputChecker();
    const reason = (MOVE_REASONS as readonly string[]).includes(input.reason) ? input.reason : null;
    if (!reason) {
      check.add(['input', 'reason'], 'INVALID', `must be one of: ${MOVE_REASONS.join(', ')}`);
    }
    const referenceDocumentUri = checkUri(check, input.referenceDocumentUri);
    checkCount(check, ['input', 'changes'], input.changes.length);
    const targets = input.changes.flatMap((change, index) => {
      const field = ['input', 'changes', String(index)];
      const quantityField = [...field, 'quantity'];
      check.integer(quantityField, change.quantity, { min: 1, max: LIMITS.quantity });
      for (const side of ['from', 'to'] as const) {
        if (change[side].name !== 'available') {
          check.add([...field, side, 'name'], 'INVALID', 'must be "available"');
        }
      }
      if (change.from.locationId === change.to.locationId) {
        check.addMessage(
          [...field, 'to', 'locationId'],
          'INVALID',
          'Stock must move to a different location',
        );
        return [];
      }
      return (['from', 'to'] as const).map((side) => ({
        variantId: change.inventoryItemId,
        locationId: change[side].locationId,
        field: [...field, side],
        itemField: [...field, 'inventoryItemId'],
        quantityField,
        delta: side === 'from' ? -change.quantity : change.quantity,
      }));
    });
    checkRepeats(check, targets);
    if (!check.ok || !reason) return { ok: false, errors: check.errors };

    const header = { name: 'available' as const, reason, referenceDocumentUri };
    return this.#change(tenant, header, targets, (level, target, errors) => {
      if (target.delta > 0) {
        return levelChange(errors, target.quantityField, level, 'available', target.delta);
      }
      if (level.available < -target.delta) {
        errors.push({
          field: target.quantityField,
          code: 'INVALID',
          message:
            `Only ${Math.max(0, level.available)} available at the location it's moved from; ` +
            `can't move ${-target.delta}`,
        });
        return null;
      }
      return { level, onHand: target.delta, committed: 0, reserved: 0, safetyStock: 0 };
    });
  }

  /** Changes to an item's quantities, newest first. */
  async history(
    tenant: TenantContext,
    variantId: string,
    options: HistoryOptions,
  ): Promise<Page<InventoryChangeRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        adjustment_id: string;
        quantity_name: QuantityName;
        delta: number;
        quantity_after: number;
        available_after: number;
        created_at: string;
        reason: string;
        reference_document_uri: string | null;
        location: LocationJson;
      }>(sql`
        SELECT m.id, m.adjustment_id, m.quantity_name, m.delta, m.quantity_after,
               m.available_after, m.created_at, a.reason, a.reference_document_uri,
               to_jsonb(loc) AS location
          FROM inventory.movements m
          JOIN inventory.adjustments a ON a.shop_id = m.shop_id AND a.id = m.adjustment_id
          JOIN inventory.locations loc ON loc.shop_id = m.shop_id AND loc.id = m.location_id
         WHERE m.shop_id = ${tenant.shopId} AND m.variant_id = ${variantId}
           ${options.locationId ? sql`AND m.location_id = ${options.locationId}` : sql``}
           ${options.after ? sql`AND m.id < ${options.after}` : sql``}
         ORDER BY m.id DESC
         LIMIT ${options.first + 1}`);
      return {
        items: rows.slice(0, options.first).map((row) => ({
          id: row.id,
          adjustmentId: row.adjustment_id,
          variantId,
          location: locationFromJson(row.location),
          name: row.quantity_name,
          delta: row.delta,
          quantityAfter: row.quantity_after,
          availableAfter: row.available_after,
          reason: row.reason,
          referenceDocumentUri: row.reference_document_uri,
          createdAt: toDate(row.created_at),
        })),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /**
   * The shared path of adjusting and setting: check the items and locations, create missing
   * items and levels, lock the levels, let `decide` turn each target into a change, and write.
   */
  async #change<T extends Target>(
    tenant: TenantContext,
    header: Header,
    targets: readonly T[],
    decide: (level: LockedLevel, target: T, errors: FieldError[]) => LevelChange | null,
  ): Promise<MutationResult<AdjustmentGroupRecord | null>> {
    return rollbackResult(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        const productIds = await this.#checkTargets(tx, tenant.shopId, targets);
        if (!(productIds instanceof Map)) return { ok: false, errors: productIds };

        const created = await ensureItems(tx, tenant.shopId, productIds);
        await ensureLevels(tx, tenant.shopId, targets);
        const levels = await lockLevels(tx, tenant.shopId, targets);
        const errors: FieldError[] = [];
        const changes: LevelChange[] = [];
        for (const target of targets) {
          const level = levels.get(levelKey(target.variantId, target.locationId))!;
          if (!level.locationActive) {
            // Deactivated since the check above.
            errors.push({
              field: [...target.field, 'locationId'],
              code: 'INVALID',
              message: 'The location is not active',
            });
            continue;
          }
          const change = decide(level, target, errors);
          if (change) changes.push(change);
        }
        if (errors.length > 0) throw new UserErrorsRollback(errors);

        await appendEvents<InventoryItemUpdatedPayload>(
          tx,
          tenant.shopId,
          created.map((variantId) => ({
            type: InventoryEvents.InventoryItemUpdated,
            aggregateType: 'inventory_item',
            aggregateId: variantId,
            payload: {
              productId: productIds.get(variantId)!,
              changed: ['tracked'],
              tracked: true,
              inventoryPolicy: 'deny',
              version: 1,
            },
          })),
        );
        const group = await writeChanges(
          tx,
          tenant.shopId,
          { ...header, actor: tenant.actor },
          changes,
        );
        return { ok: true, value: group };
      }),
    );
  }

  /** The product of each target's variant, or errors for unknown variants and locations. */
  async #checkTargets(
    tx: Tx,
    shopId: string,
    targets: readonly Target[],
  ): Promise<Map<string, string> | FieldError[]> {
    const productIds = await this.variants.productIdsOf(
      tx,
      shopId,
      targets.map((target) => target.variantId),
    );
    const found = await tx
      .select({ id: locations.id, isActive: locations.isActive })
      .from(locations)
      .where(
        and(
          eq(locations.shopId, shopId),
          inArray(locations.id, [...new Set(targets.map((target) => target.locationId))]),
        ),
      );
    const active = new Map(found.map((location) => [location.id, location.isActive]));
    const errors: FieldError[] = [];
    const unknownItems = new Set<string>();
    for (const target of targets) {
      const itemField = target.itemField ?? [...target.field, 'inventoryItemId'];
      if (!productIds.has(target.variantId) && !unknownItems.has(itemField.join('.'))) {
        unknownItems.add(itemField.join('.'));
        errors.push({ field: itemField, code: 'NOT_FOUND', message: 'Inventory item not found' });
      }
      const isActive = active.get(target.locationId);
      if (isActive === undefined) {
        errors.push({
          field: [...target.field, 'locationId'],
          code: 'NOT_FOUND',
          message: 'Location not found',
        });
      } else if (!isActive) {
        errors.push({
          field: [...target.field, 'locationId'],
          code: 'INVALID',
          message: 'The location is not active',
        });
      }
    }
    return errors.length > 0 ? errors : productIds;
  }
}
