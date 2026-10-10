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
import { Database, isUniqueViolation, toDate, type Tx } from '@hatti/db';
import { newId, toPublicId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { InventoryService, levelChange } from './inventory.service.js';
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
   * with the reason "received" naming the order, never more than is still to come. Once every
   * line has come in full, the order is received.
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
        await tx.execute(sql`
          UPDATE inventory.purchase_orders o
             SET status = CASE WHEN NOT EXISTS (
                            SELECT 1 FROM inventory.purchase_order_lines l
                             WHERE l.shop_id = o.shop_id AND l.purchase_order_id = o.id
                               AND l.received < l.quantity)
                          THEN 'received' ELSE 'open' END,
                 closed_at = CASE WHEN NOT EXISTS (
                            SELECT 1 FROM inventory.purchase_order_lines l
                             WHERE l.shop_id = o.shop_id AND l.purchase_order_id = o.id
                               AND l.received < l.quantity)
                          THEN now() END,
                 version = o.version + 1,
                 updated_at = now()
           WHERE o.shop_id = ${tenant.shopId} AND o.id = ${id}`);
        const [received] = await this.#load(tx, tenant.shopId, { ids: [id] });
        return { ok: true, value: received! };
      }),
    );
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
