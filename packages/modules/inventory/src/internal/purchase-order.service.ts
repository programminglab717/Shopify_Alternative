import {
  InputChecker,
  UserErrorsRollback,
  failOne,
  rollbackResult,
  shopProfile,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { Database, isUniqueViolation, toDate, type Tx } from '@hatti/db';
import { newId, toPublicId } from '@hatti/ids';
import type { Language } from '@hatti/documents';
import type { CurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { InventoryService, levelChange } from './inventory.service.js';
import { purchaseOrderDocument } from './purchase-order-document.js';
import { locationFromJson, type LocationJson } from './location-store.js';
import type { LocationRecord, Page } from './records.js';
import { LIMITS } from './rules.js';
import {
  locations,
  purchaseOrderLines,
  purchaseOrders,
  suppliers,
  type PurchaseOrderStatusValue,
} from './schema.js';

export interface SupplierRecord {
  id: string;
  name: string;
  /** A Pakistani mobile number in E.164 form. */
  phone: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierInput {
  name?: string | null;
  phone?: string | null;
  note?: string | null;
}

export interface PurchaseOrderLineRecord {
  id: string;
  variantId: string;
  /** As the variant was named when ordered. */
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  received: number;
  /** Minor units in the shop's currency; null where the shop gave none. */
  unitCost: bigint | null;
}

export interface PurchaseOrderRecord {
  id: string;
  number: number;
  status: PurchaseOrderStatusValue;
  supplier: SupplierRecord;
  location: LocationRecord;
  reference: string | null;
  note: string | null;
  /** The day the goods are expected, as YYYY-MM-DD. */
  expectedOn: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lines: PurchaseOrderLineRecord[];
}

export interface PurchaseOrderLineInput {
  inventoryItemId: string;
  quantity: number;
  /** What one costs, in major units: "1450" or "1450.50". */
  unitCost?: string | null;
}

export interface PurchaseOrderCreateInput {
  supplierId: string;
  locationId: string;
  reference?: string | null;
  note?: string | null;
  expectedOn?: string | null;
  lines: PurchaseOrderLineInput[];
}

export interface PurchaseOrderLineUpdateInput {
  lineId: string;
  /** No fewer than came already. */
  quantity?: number | null;
  /** Blank or null clears it. */
  unitCost?: string | null;
}

export interface PurchaseOrderUpdateInput {
  /** Each of these, when given, replaces what the order had; blank or null clears it. */
  reference?: string | null;
  note?: string | null;
  expectedOn?: string | null;
  linesToAdd?: PurchaseOrderLineInput[] | null;
  linesToUpdate?: PurchaseOrderLineUpdateInput[] | null;
  /** Lines none of which came yet. */
  lineIdsToRemove?: string[] | null;
}

export interface PurchaseOrderReceiveInput {
  lines: { lineId: string; quantity: number }[];
}

export interface PurchaseOrderListOptions {
  first: number;
  /** The number of the last purchase order of the previous page. */
  afterNumber?: number | null;
  status?: PurchaseOrderStatusValue | null;
  supplierId?: string | null;
}

/** What of a variant is on order, and who supplied it last, to reorder it. */
export interface ReorderRecord {
  /** Units on open purchase orders, not yet received. */
  incoming: number;
  /** The supplier of its latest purchase order, whatever its status. */
  lastSupplier: SupplierRecord | null;
  /** What one cost on that order, in minor units; null where the shop gave none. */
  lastUnitCost: bigint | null;
}

/** At most this many suppliers a shop, all listed at once. */
export const SUPPLIER_LIMIT = 250;

const SUPPLIER_TAKEN = 'A supplier with this name already exists';
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The ledger's reference to a purchase order, which history links to it by. */
export function purchaseOrderUri(id: string): string {
  return `hatti://purchase-orders/${toPublicId('purchaseOrder', id)}`;
}

function toSupplier(row: typeof suppliers.$inferSelect): SupplierRecord {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A real day, as YYYY-MM-DD; null when blank, after an error where it is not one. */
function checkDay(check: InputChecker, field: string[], value: string | null | undefined) {
  const text = value?.trim() ?? '';
  if (text === '') return null;
  const match = ISO_DAY.exec(text);
  const day = match ? new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!)) : null;
  if (!day || day.toISOString().slice(0, 10) !== text) {
    check.add(field, 'INVALID', 'must be a day, like 2026-11-30');
    return null;
  }
  return text;
}

/**
 * The shop's suppliers and its purchase orders (INV-05): goods ordered from a supplier for a
 * location, and received into stock there as they come, each receipt one adjustment in the ledger
 * with the reason "received" naming the order.
 */
@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly inventory: InventoryService,
  ) {}

  /** The shop's suppliers, by name. */
  suppliers(tenant: TenantContext): Promise<SupplierRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(suppliers)
        .where(eq(suppliers.shopId, tenant.shopId))
        .orderBy(sql`lower(${suppliers.name})`)
        .limit(SUPPLIER_LIMIT);
      return rows.map(toSupplier);
    });
  }

  /**
   * For each of these variants: the units on open purchase orders not yet received, and the
   * supplier and unit cost of its latest purchase order. Variants never ordered are left out.
   */
  reordersOf(
    tenant: TenantContext,
    variantIds: readonly string[],
  ): Promise<Map<string, ReorderRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        variant_id: string;
        incoming: number;
        unit_cost: string | null;
        supplier: {
          id: string;
          name: string;
          phone: string | null;
          note: string | null;
          created_at: string;
          updated_at: string;
        };
      }>(sql`
        WITH ordered AS (
          SELECT l.variant_id, l.unit_cost, o.supplier_id, o.number,
                 CASE WHEN o.status = 'open' THEN l.quantity - l.received ELSE 0 END AS incoming
            FROM inventory.purchase_order_lines l
            JOIN inventory.purchase_orders o
              ON o.shop_id = l.shop_id AND o.id = l.purchase_order_id
           WHERE l.shop_id = ${tenant.shopId}
             AND l.variant_id = ANY(${sql.param([...variantIds])}::uuid[])
        ),
        latest AS (
          SELECT DISTINCT ON (variant_id) variant_id, unit_cost, supplier_id
            FROM ordered
           ORDER BY variant_id, number DESC
        )
        SELECT latest.variant_id, latest.unit_cost::text AS unit_cost, to_jsonb(s) AS supplier,
               (SELECT coalesce(sum(incoming), 0)::int FROM ordered
                 WHERE ordered.variant_id = latest.variant_id) AS incoming
          FROM latest
          JOIN inventory.suppliers s
            ON s.shop_id = ${tenant.shopId} AND s.id = latest.supplier_id`);
      return new Map(
        rows.map((row) => [
          row.variant_id,
          {
            incoming: row.incoming,
            lastSupplier: {
              id: row.supplier.id,
              name: row.supplier.name,
              phone: row.supplier.phone,
              note: row.supplier.note,
              createdAt: new Date(row.supplier.created_at),
              updatedAt: new Date(row.supplier.updated_at),
            },
            lastUnitCost: row.unit_cost === null ? null : BigInt(row.unit_cost),
          },
        ]),
      );
    });
  }

  async createSupplier(
    tenant: TenantContext,
    input: SupplierInput,
  ): Promise<MutationResult<SupplierRecord>> {
    const check = new InputChecker();
    const name = check.text(['input', 'name'], input.name, { required: true, max: 255 });
    const phone = check.mobile(['input', 'phone'], input.phone);
    const note = check.text(['input', 'note'], input.note, { max: 5000 });
    if (!check.ok || !name) return { ok: false, errors: check.errors };
    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const [{ total } = { total: 0 }] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(suppliers)
          .where(eq(suppliers.shopId, tenant.shopId));
        if (total >= SUPPLIER_LIMIT) {
          return failOne(
            ['input'],
            'TOO_MANY',
            `A shop can have at most ${SUPPLIER_LIMIT} suppliers`,
          );
        }
        const [row] = await tx
          .insert(suppliers)
          .values({ shopId: tenant.shopId, id: newId(), name, phone, note })
          .returning();
        return { ok: true, value: toSupplier(row!) };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'suppliers_name_key')) {
        return failOne(['input', 'name'], 'TAKEN', SUPPLIER_TAKEN);
      }
      throw error;
    }
  }

  /** Changes what is given; null or blank clears the phone or note. */
  async updateSupplier(
    tenant: TenantContext,
    id: string,
    input: SupplierInput,
  ): Promise<MutationResult<SupplierRecord>> {
    const check = new InputChecker();
    const name =
      input.name === undefined
        ? undefined
        : check.text(['input', 'name'], input.name, { required: true, max: 255 });
    const phone =
      input.phone === undefined ? undefined : check.mobile(['input', 'phone'], input.phone);
    const note =
      input.note === undefined
        ? undefined
        : check.text(['input', 'note'], input.note, { max: 5000 });
    if (!check.ok || name === null) return { ok: false, errors: check.errors };
    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const [row] = await tx
          .update(suppliers)
          .set({
            ...(name !== undefined && { name }),
            ...(phone !== undefined && { phone }),
            ...(note !== undefined && { note }),
            version: sql`${suppliers.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(suppliers.shopId, tenant.shopId), eq(suppliers.id, id)))
          .returning();
        if (!row) return failOne(['id'], 'NOT_FOUND', 'Supplier not found');
        return { ok: true, value: toSupplier(row) };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'suppliers_name_key')) {
        return failOne(['input', 'name'], 'TAKEN', SUPPLIER_TAKEN);
      }
      throw error;
    }
  }

  /** A purchase order, or null if the shop has none with `id`. */
  get(tenant: TenantContext, id: string): Promise<PurchaseOrderRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [found] = await this.#load(tx, tenant.shopId, { ids: [id] });
      return found ?? null;
    });
  }

  /**
   * A purchase order as a page to print or save for its supplier, in `language`; null if the shop
   * has none with `id`.
   */
  document(
    tenant: TenantContext,
    id: string,
    language: Language,
  ): Promise<{ html: string; title: string; fileName: string } | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [order] = await this.#load(tx, tenant.shopId, { ids: [id] });
      if (!order) return null;
      return purchaseOrderDocument(order, {
        language,
        shop: await shopProfile(tx, tenant.shopId),
        currency: tenant.currency as CurrencyCode,
      });
    });
  }

  /** Purchase orders, the newest first. */
  list(
    tenant: TenantContext,
    options: PurchaseOrderListOptions,
  ): Promise<Page<PurchaseOrderRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const found = await this.#load(tx, tenant.shopId, { ...options, first: options.first + 1 });
      return { items: found.slice(0, options.first), hasNextPage: found.length > options.first };
    });
  }

  /** Orders goods from a supplier for a location; it is open until they all come or it is closed. */
  async create(
    tenant: TenantContext,
    input: PurchaseOrderCreateInput,
  ): Promise<MutationResult<PurchaseOrderRecord>> {
    const check = new InputChecker();
    const reference = check.text(['input', 'reference'], input.reference, { max: 255 });
    const note = check.text(['input', 'note'], input.note, { max: 5000 });
    const expectedOn = checkDay(check, ['input', 'expectedOn'], input.expectedOn);
    if (input.lines.length === 0)
      check.add(['input', 'lines'], 'BLANK', 'must include at least one');
    if (input.lines.length > LIMITS.changes) {
      check.add(['input', 'lines'], 'TOO_MANY', `can have at most ${LIMITS.changes}`);
    }
    const seen = new Set<string>();
    const lines = input.lines.map((line, index) => {
      const field = ['input', 'lines', String(index)];
      if (seen.has(line.inventoryItemId)) {
        check.addMessage(field, 'INVALID', 'The same item is listed twice');
      }
      seen.add(line.inventoryItemId);
      check.integer([...field, 'quantity'], line.quantity, { min: 1, max: LIMITS.quantity });
      return {
        variantId: line.inventoryItemId,
        quantity: line.quantity,
        unitCost: check.price([...field, 'unitCost'], line.unitCost, tenant.currency),
        field,
      };
    });
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const errors: FieldError[] = [];
      const [supplier] = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(and(eq(suppliers.shopId, tenant.shopId), eq(suppliers.id, input.supplierId)));
      if (!supplier) {
        errors.push({
          field: ['input', 'supplierId'],
          code: 'NOT_FOUND',
          message: 'Supplier not found',
        });
      }
      const [location] = await tx
        .select({ isActive: locations.isActive })
        .from(locations)
        .where(and(eq(locations.shopId, tenant.shopId), eq(locations.id, input.locationId)));
      if (!location) {
        errors.push({
          field: ['input', 'locationId'],
          code: 'NOT_FOUND',
          message: 'Location not found',
        });
      } else if (!location.isActive) {
        errors.push({
          field: ['input', 'locationId'],
          code: 'INVALID',
          message: 'The location is not active',
        });
      }
      const snapshots = await this.variants.snapshotsOf(
        tx,
        tenant.shopId,
        lines.map((line) => line.variantId),
      );
      for (const line of lines) {
        if (!snapshots.has(line.variantId)) {
          errors.push({
            field: [...line.field, 'inventoryItemId'],
            code: 'NOT_FOUND',
            message: 'Inventory item not found',
          });
        }
      }
      if (errors.length > 0) return { ok: false, errors };

      // The number is taken last, so that the counter row is locked briefly.
      const id = newId();
      const { rows } = await tx.execute<{ number: number }>(sql`
        INSERT INTO inventory.purchase_order_counters AS c (shop_id, next_number)
        VALUES (${tenant.shopId}, 2)
        ON CONFLICT (shop_id) DO UPDATE SET next_number = c.next_number + 1
        RETURNING next_number - 1 AS number`);
      await tx.insert(purchaseOrders).values({
        shopId: tenant.shopId,
        id,
        number: rows[0]!.number,
        supplierId: input.supplierId,
        locationId: input.locationId,
        reference,
        note,
        expectedOn,
      });
      await tx.insert(purchaseOrderLines).values(
        lines.map((line, position) => {
          const snapshot = snapshots.get(line.variantId)!;
          return {
            shopId: tenant.shopId,
            purchaseOrderId: id,
            id: newId(),
            position,
            variantId: line.variantId,
            productTitle: snapshot.productTitle,
            variantTitle: snapshot.variantTitle,
            sku: snapshot.sku,
            quantity: line.quantity,
            unitCost: line.unitCost,
          };
        }),
      );
      const [created] = await this.#load(tx, tenant.shopId, { ids: [id] });
      return { ok: true, value: created! };
    });
  }

  /**
   * Goods come: each line's quantity added to on hand at the order's location, in one adjustment
   * with the reason "received" naming the order, never more than is still to come; a line's cost
   * averaged into its variant's. Once every line has come in full, the order is received.
   */
  async receive(
    tenant: TenantContext,
    id: string,
    input: PurchaseOrderReceiveInput,
  ): Promise<MutationResult<PurchaseOrderRecord>> {
    const check = new InputChecker();
    if (input.lines.length === 0)
      check.add(['input', 'lines'], 'BLANK', 'must include at least one');
    if (input.lines.length > LIMITS.changes) {
      check.add(['input', 'lines'], 'TOO_MANY', `can have at most ${LIMITS.changes}`);
    }
    const seen = new Set<string>();
    input.lines.forEach((line, index) => {
      const field = ['input', 'lines', String(index)];
      if (seen.has(line.lineId))
        check.addMessage(field, 'INVALID', 'The same line is listed twice');
      seen.add(line.lineId);
      check.integer([...field, 'quantity'], line.quantity, { min: 1, max: LIMITS.quantity });
    });
    if (!check.ok) return { ok: false, errors: check.errors };

    return rollbackResult(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        const [order] = await tx
          .select({ status: purchaseOrders.status, locationId: purchaseOrders.locationId })
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.shopId, tenant.shopId), eq(purchaseOrders.id, id)))
          .for('update');
        if (!order) return failOne(['id'], 'NOT_FOUND', 'Purchase order not found');
        if (order.status !== 'open') {
          return failOne(['id'], 'INVALID', `The purchase order is ${order.status} already`);
        }
        const lines = new Map(
          (
            await tx
              .select()
              .from(purchaseOrderLines)
              .where(
                and(
                  eq(purchaseOrderLines.shopId, tenant.shopId),
                  eq(purchaseOrderLines.purchaseOrderId, id),
                ),
              )
          ).map((line) => [line.id, line]),
        );
        const errors: FieldError[] = [];
        const targets = input.lines.flatMap((wanted, index) => {
          const field = ['input', 'lines', String(index)];
          const line = lines.get(wanted.lineId);
          if (!line) {
            errors.push({
              field: [...field, 'lineId'],
              code: 'NOT_FOUND',
              message: 'Line not found',
            });
            return [];
          }
          const left = line.quantity - line.received;
          if (wanted.quantity > left) {
            errors.push({
              field: [...field, 'quantity'],
              code: 'INVALID',
              message: `Only ${left} still to come of ${line.quantity}; can't receive ${wanted.quantity}`,
            });
            return [];
          }
          return [
            {
              lineId: line.id,
              unitCost: line.unitCost,
              variantId: line.variantId,
              locationId: order.locationId,
              field,
              itemField: [...field, 'lineId'],
              quantity: wanted.quantity,
            },
          ];
        });
        if (errors.length > 0) throw new UserErrorsRollback(errors);

        await this.inventory.changeIn(
          tx,
          tenant,
          { name: 'available', reason: 'received', referenceDocumentUri: purchaseOrderUri(id) },
          targets,
          (level, target, problems) =>
            levelChange(
              problems,
              [...target.field, 'quantity'],
              level,
              'available',
              target.quantity,
            ),
        );
        await tx.execute(sql`
          UPDATE inventory.purchase_order_lines l
             SET received = l.received + r.quantity
            FROM unnest(${sql.param(targets.map((target) => target.lineId))}::uuid[],
                        ${sql.param(targets.map((target) => target.quantity))}::int[])
                 AS r(id, quantity)
           WHERE l.shop_id = ${tenant.shopId} AND l.id = r.id`);
        await this.#averageCosts(tx, tenant.shopId, targets);
        await this.#settle(tx, tenant.shopId, id);
        const [received] = await this.#load(tx, tenant.shopId, { ids: [id] });
        return { ok: true, value: received! };
      }),
    );
  }

  /**
   * Changes an open order: its supplier's number, note and day expected; lines added, their
   * quantities or costs changed, never below what came already, and lines none of which came
   * removed. An order whose every line has come in full after it is received.
   */
  async update(
    tenant: TenantContext,
    id: string,
    input: PurchaseOrderUpdateInput,
  ): Promise<MutationResult<PurchaseOrderRecord>> {
    const check = new InputChecker();
    const reference =
      input.reference === undefined
        ? undefined
        : check.text(['input', 'reference'], input.reference, { max: 255 });
    const note =
      input.note === undefined
        ? undefined
        : check.text(['input', 'note'], input.note, { max: 5000 });
    const expectedOn =
      input.expectedOn === undefined
        ? undefined
        : checkDay(check, ['input', 'expectedOn'], input.expectedOn);
    const seen = new Set<string>();
    const adds = (input.linesToAdd ?? []).map((line, index) => {
      const field = ['input', 'linesToAdd', String(index)];
      if (seen.has(line.inventoryItemId)) {
        check.addMessage(field, 'INVALID', 'The same item is listed twice');
      }
      seen.add(line.inventoryItemId);
      check.integer([...field, 'quantity'], line.quantity, { min: 1, max: LIMITS.quantity });
      return {
        variantId: line.inventoryItemId,
        quantity: line.quantity,
        unitCost: check.price([...field, 'unitCost'], line.unitCost, tenant.currency),
        field,
      };
    });
    const updated = new Set<string>();
    const updates = (input.linesToUpdate ?? []).map((line, index) => {
      const field = ['input', 'linesToUpdate', String(index)];
      if (updated.has(line.lineId)) {
        check.addMessage(field, 'INVALID', 'The same line is listed twice');
      }
      updated.add(line.lineId);
      if (line.quantity !== undefined && line.quantity !== null) {
        check.integer([...field, 'quantity'], line.quantity, { min: 1, max: LIMITS.quantity });
      }
      return {
        lineId: line.lineId,
        quantity: line.quantity ?? null,
        unitCost:
          line.unitCost === undefined
            ? undefined
            : check.price([...field, 'unitCost'], line.unitCost, tenant.currency),
        field,
      };
    });
    const removes = [...new Set(input.lineIdsToRemove ?? [])];
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const [order] = await tx
        .select({ status: purchaseOrders.status })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.shopId, tenant.shopId), eq(purchaseOrders.id, id)))
        .for('update');
      if (!order) return failOne(['id'], 'NOT_FOUND', 'Purchase order not found');
      if (order.status !== 'open') {
        return failOne(['id'], 'INVALID', `The purchase order is ${order.status} already`);
      }
      const lines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(
          and(
            eq(purchaseOrderLines.shopId, tenant.shopId),
            eq(purchaseOrderLines.purchaseOrderId, id),
          ),
        );
      const byId = new Map(lines.map((line) => [line.id, line]));
      const errors: FieldError[] = [];
      removes.forEach((lineId, index) => {
        const line = byId.get(lineId);
        const field = ['input', 'lineIdsToRemove', String(index)];
        if (!line) errors.push({ field, code: 'NOT_FOUND', message: 'Line not found' });
        else if (line.received > 0) {
          errors.push({
            field,
            code: 'INVALID',
            message: `${line.received} came already; the line can't be removed`,
          });
        }
      });
      for (const update of updates) {
        const line = byId.get(update.lineId);
        if (!line) {
          errors.push({
            field: [...update.field, 'lineId'],
            code: 'NOT_FOUND',
            message: 'Line not found',
          });
        } else if (removes.includes(line.id)) {
          errors.push({
            field: [...update.field, 'lineId'],
            code: 'INVALID',
            message: 'The line is removed in the same change',
          });
        } else if (update.quantity !== null && update.quantity < line.received) {
          errors.push({
            field: [...update.field, 'quantity'],
            code: 'INVALID',
            message: `${line.received} came already; it can't be fewer`,
          });
        }
      }
      const snapshots = await this.variants.snapshotsOf(
        tx,
        tenant.shopId,
        adds.map((add) => add.variantId),
      );
      const kept = new Set(
        lines.filter((line) => !removes.includes(line.id)).map((line) => line.variantId),
      );
      for (const add of adds) {
        if (!snapshots.has(add.variantId)) {
          errors.push({
            field: [...add.field, 'inventoryItemId'],
            code: 'NOT_FOUND',
            message: 'Inventory item not found',
          });
        } else if (kept.has(add.variantId)) {
          errors.push({
            field: [...add.field, 'inventoryItemId'],
            code: 'INVALID',
            message: 'The item is on the order already',
          });
        }
      }
      const remaining = lines.length - removes.length + adds.length;
      if (remaining === 0) {
        errors.push({
          field: ['input'],
          code: 'INVALID',
          message: 'An order needs at least one line',
        });
      }
      if (remaining > LIMITS.changes) {
        errors.push({
          field: ['input', 'linesToAdd'],
          code: 'TOO_MANY',
          message: `An order can have at most ${LIMITS.changes} lines`,
        });
      }
      if (errors.length > 0) return { ok: false, errors };

      if (removes.length > 0) {
        await tx
          .delete(purchaseOrderLines)
          .where(
            and(
              eq(purchaseOrderLines.shopId, tenant.shopId),
              sql`${purchaseOrderLines.id} = ANY(${sql.param(removes)}::uuid[])`,
            ),
          );
      }
      for (const update of updates) {
        if (update.quantity === null && update.unitCost === undefined) continue;
        await tx
          .update(purchaseOrderLines)
          .set({
            ...(update.quantity !== null && { quantity: update.quantity }),
            ...(update.unitCost !== undefined && { unitCost: update.unitCost }),
          })
          .where(
            and(
              eq(purchaseOrderLines.shopId, tenant.shopId),
              eq(purchaseOrderLines.id, update.lineId),
            ),
          );
      }
      if (adds.length > 0) {
        const after = Math.max(-1, ...lines.map((line) => line.position));
        await tx.insert(purchaseOrderLines).values(
          adds.map((add, index) => {
            const snapshot = snapshots.get(add.variantId)!;
            return {
              shopId: tenant.shopId,
              purchaseOrderId: id,
              id: newId(),
              position: after + 1 + index,
              variantId: add.variantId,
              productTitle: snapshot.productTitle,
              variantTitle: snapshot.variantTitle,
              sku: snapshot.sku,
              quantity: add.quantity,
              unitCost: add.unitCost,
            };
          }),
        );
      }
      const fields = {
        ...(reference !== undefined && { reference }),
        ...(note !== undefined && { note }),
        ...(expectedOn !== undefined && { expectedOn }),
      };
      if (Object.keys(fields).length > 0) {
        await tx
          .update(purchaseOrders)
          .set(fields)
          .where(and(eq(purchaseOrders.shopId, tenant.shopId), eq(purchaseOrders.id, id)));
      }
      await this.#settle(tx, tenant.shopId, id);
      const [changed] = await this.#load(tx, tenant.shopId, { ids: [id] });
      return { ok: true, value: changed! };
    });
  }

  /** Closes an open order with what came: the rest is no longer expected. */
  async close(tenant: TenantContext, id: string): Promise<MutationResult<PurchaseOrderRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [order] = await tx
        .select({ status: purchaseOrders.status })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.shopId, tenant.shopId), eq(purchaseOrders.id, id)))
        .for('update');
      if (!order) return failOne(['id'], 'NOT_FOUND', 'Purchase order not found');
      if (order.status !== 'open') {
        return failOne(['id'], 'INVALID', `The purchase order is ${order.status} already`);
      }
      await tx
        .update(purchaseOrders)
        .set({
          status: 'closed',
          closedAt: sql`now()`,
          version: sql`${purchaseOrders.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(purchaseOrders.shopId, tenant.shopId), eq(purchaseOrders.id, id)));
      const [closed] = await this.#load(tx, tenant.shopId, { ids: [id] });
      return { ok: true, value: closed! };
    });
  }

  /**
   * What one of each variant received costs the shop, from the order's cost where it has one:
   * averaged with what was on hand before, at what it cost then, or the order's cost where none was
   * on hand or no cost was known. Rounded to the paisa, half up.
   */
  async #averageCosts(
    tx: Tx,
    shopId: string,
    received: readonly { variantId: string; quantity: number; unitCost: bigint | null }[],
  ): Promise<void> {
    const costed = received.filter((each) => each.unitCost !== null);
    if (costed.length === 0) return;
    const ids = costed.map((each) => each.variantId);
    const snapshots = await this.variants.snapshotsOf(tx, shopId, ids);
    const { rows } = await tx.execute<{ variant_id: string; on_hand: number }>(sql`
      SELECT variant_id, sum(on_hand)::int AS on_hand
        FROM inventory.levels
       WHERE shop_id = ${shopId} AND variant_id = ANY(${sql.param(ids)}::uuid[])
       GROUP BY variant_id`);
    const onHand = new Map(rows.map((row) => [row.variant_id, row.on_hand]));
    const costs = new Map<string, bigint>();
    for (const each of costed) {
      const before = BigInt((onHand.get(each.variantId) ?? 0) - each.quantity);
      const old = snapshots.get(each.variantId)?.cost ?? null;
      const unit = each.unitCost!;
      if (old === null || before <= 0n) {
        costs.set(each.variantId, unit);
        continue;
      }
      const total = before + BigInt(each.quantity);
      const sum = old * before + unit * BigInt(each.quantity);
      costs.set(each.variantId, (sum * 2n + total) / (2n * total));
    }
    await this.variants.setCostsIn(tx, shopId, costs);
  }

  /**
   * After a change to an open order's lines: received once every line has come in full, with
   * when; its version moves on either way.
   */
  async #settle(tx: Tx, shopId: string, id: string): Promise<void> {
    await tx.execute(sql`
      WITH done AS (
        SELECT NOT EXISTS (
                 SELECT 1 FROM inventory.purchase_order_lines l
                  WHERE l.shop_id = ${shopId} AND l.purchase_order_id = ${id}
                    AND l.received < l.quantity) AS all_came
      )
      UPDATE inventory.purchase_orders o
         SET status = CASE WHEN done.all_came THEN 'received' ELSE 'open' END,
             closed_at = CASE WHEN done.all_came THEN now() END,
             version = o.version + 1,
             updated_at = now()
        FROM done
       WHERE o.shop_id = ${shopId} AND o.id = ${id}`);
  }

  /** Purchase orders with their supplier, location and lines, the newest first. */
  async #load(
    tx: Tx,
    shopId: string,
    filter: {
      ids?: string[];
      first?: number;
      afterNumber?: number | null;
      status?: PurchaseOrderStatusValue | null;
      supplierId?: string | null;
    },
  ): Promise<PurchaseOrderRecord[]> {
    const { rows } = await tx.execute<{
      id: string;
      number: number;
      status: PurchaseOrderStatusValue;
      reference: string | null;
      note: string | null;
      expected_on: string | null;
      closed_at: string | null;
      created_at: string;
      updated_at: string;
      supplier: {
        id: string;
        name: string;
        phone: string | null;
        note: string | null;
        created_at: string;
        updated_at: string;
      };
      location: LocationJson;
    }>(sql`
      SELECT o.id, o.number, o.status, o.reference, o.note, o.expected_on::text AS expected_on,
             o.closed_at, o.created_at, o.updated_at,
             to_jsonb(s) AS supplier, to_jsonb(loc) AS location
        FROM inventory.purchase_orders o
        JOIN inventory.suppliers s ON s.shop_id = o.shop_id AND s.id = o.supplier_id
        JOIN inventory.locations loc ON loc.shop_id = o.shop_id AND loc.id = o.location_id
       WHERE o.shop_id = ${shopId}
         ${filter.ids ? sql`AND o.id = ANY(${sql.param(filter.ids)}::uuid[])` : sql``}
         ${filter.status ? sql`AND o.status = ${filter.status}` : sql``}
         ${filter.supplierId ? sql`AND o.supplier_id = ${filter.supplierId}` : sql``}
         ${filter.afterNumber ? sql`AND o.number < ${filter.afterNumber}` : sql``}
       ORDER BY o.number DESC
       ${filter.first ? sql`LIMIT ${filter.first}` : sql``}`);
    if (rows.length === 0) return [];
    const lines = await tx
      .select()
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.shopId, shopId),
          sql`${purchaseOrderLines.purchaseOrderId} = ANY(${sql.param(rows.map((row) => row.id))}::uuid[])`,
        ),
      )
      .orderBy(asc(purchaseOrderLines.position));
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      supplier: {
        id: row.supplier.id,
        name: row.supplier.name,
        phone: row.supplier.phone,
        note: row.supplier.note,
        createdAt: new Date(row.supplier.created_at),
        updatedAt: new Date(row.supplier.updated_at),
      },
      location: locationFromJson(row.location),
      reference: row.reference,
      note: row.note,
      expectedOn: row.expected_on,
      closedAt: row.closed_at === null ? null : toDate(row.closed_at),
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
      lines: lines
        .filter((line) => line.purchaseOrderId === row.id)
        .map((line) => ({
          id: line.id,
          variantId: line.variantId,
          productTitle: line.productTitle,
          variantTitle: line.variantTitle,
          sku: line.sku,
          quantity: line.quantity,
          received: line.received,
          unitCost: line.unitCost,
        })),
    }));
  }
}
