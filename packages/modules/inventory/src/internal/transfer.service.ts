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
import { Database, toDate, type Tx } from '@hatti/db';
import type { Language } from '@hatti/documents';
import { newId, toPublicId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { InventoryService, levelChange } from './inventory.service.js';
import { locationFromJson, type LocationJson } from './location-store.js';
import type { LocationRecord, Page } from './records.js';
import { LIMITS } from './rules.js';
import { locations, transferLines, transfers, type TransferStatusValue } from './schema.js';
import { transferDocument } from './transfer-document.js';

export interface TransferLineRecord {
  id: string;
  variantId: string;
  /** As the variant was named when sent. */
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  received: number;
}

export interface TransferRecord {
  id: string;
  number: number;
  status: TransferStatusValue;
  origin: LocationRecord;
  destination: LocationRecord;
  reference: string | null;
  note: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lines: TransferLineRecord[];
}

export interface TransferCreateInput {
  originId: string;
  destinationId: string;
  reference?: string | null;
  note?: string | null;
  lines: { inventoryItemId: string; quantity: number }[];
}

export interface TransferReceiveInput {
  lines: { lineId: string; quantity: number }[];
}

export interface TransferListOptions {
  first: number;
  /** The number of the last transfer of the previous page. */
  afterNumber?: number | null;
  status?: TransferStatusValue | null;
  /** Transfers leaving from or arriving at this location. */
  locationId?: string | null;
}

/** Why stock moved, as Shopify's ledger names a transfer's: sent, arrived, and put back. */
export const TRANSFER_REASONS = {
  send: 'movement_created',
  receive: 'movement_received',
  cancel: 'movement_canceled',
} as const;

/** The ledger's reference to a transfer, which history links to it by. */
export function transferUri(id: string): string {
  return `hatti://transfers/${toPublicId('inventoryTransfer', id)}`;
}

/**
 * Transfers between a shop's locations (INV-04, ADR-360): stock sent from one location, on its way
 * until it is received at the other. Sending takes it off on hand where it leaves, no more than is
 * available there; each receipt adds to on hand where it arrives; cancelling puts back where it
 * left what had not arrived. Each is one adjustment in the ledger naming the transfer.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly inventory: InventoryService,
  ) {}

  /** A transfer, or null if the shop has none with `id`. */
  get(tenant: TenantContext, id: string): Promise<TransferRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [found] = await this.#load(tx, tenant.shopId, { ids: [id] });
      return found ?? null;
    });
  }

  /**
   * A transfer as a page to print or save to go with the stock (ADR-362), in `language`; null if
   * the shop has none with `id`.
   */
  document(
    tenant: TenantContext,
    id: string,
    language: Language,
  ): Promise<{ html: string; title: string; fileName: string } | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [transfer] = await this.#load(tx, tenant.shopId, { ids: [id] });
      if (!transfer) return null;
      return transferDocument(transfer, {
        language,
        shop: await shopProfile(tx, tenant.shopId),
      });
    });
  }

  /** Transfers, the newest first. */
  list(tenant: TenantContext, options: TransferListOptions): Promise<Page<TransferRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const found = await this.#load(tx, tenant.shopId, { ...options, first: options.first + 1 });
      return { items: found.slice(0, options.first), hasNextPage: found.length > options.first };
    });
  }

  /** For each of these variants, the units on their way to `locationId`; none are left out. */
  incomingOf(
    tenant: TenantContext,
    variantIds: readonly string[],
    locationId: string,
  ): Promise<Map<string, number>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ variant_id: string; incoming: number }>(sql`
        SELECT l.variant_id, sum(l.quantity - l.received)::int AS incoming
          FROM inventory.transfer_lines l
          JOIN inventory.transfers t ON t.shop_id = l.shop_id AND t.id = l.transfer_id
         WHERE l.shop_id = ${tenant.shopId}
           AND l.variant_id = ANY(${sql.param([...variantIds])}::uuid[])
           AND t.status = 'in_transit' AND t.destination_id = ${locationId}
         GROUP BY l.variant_id`);
      const incoming = new Map(rows.map((row) => [row.variant_id, row.incoming]));
      return new Map(variantIds.map((id) => [id, incoming.get(id) ?? 0]));
    });
  }

  /**
   * Sends stock from one active location to another, numbered T-1 onwards: each line taken off on
   * hand where it leaves, no more than is available there, in one adjustment. It is on its way
   * until it is received.
   */
  async create(
    tenant: TenantContext,
    input: TransferCreateInput,
  ): Promise<MutationResult<TransferRecord>> {
    const check = new InputChecker();
    const reference = check.text(['input', 'reference'], input.reference, { max: 255 });
    const note = check.text(['input', 'note'], input.note, { max: 5000 });
    if (input.originId === input.destinationId) {
      check.addMessage(
        ['input', 'destinationId'],
        'INVALID',
        'Stock must go to a different location',
      );
    }
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
        locationId: input.originId,
        quantity: line.quantity,
        field,
        itemField: [...field, 'inventoryItemId'],
      };
    });
    if (!check.ok) return { ok: false, errors: check.errors };

    return rollbackResult(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        const errors: FieldError[] = [];
        const found = new Map(
          (
            await tx
              .select({ id: locations.id, name: locations.name, isActive: locations.isActive })
              .from(locations)
              .where(
                and(
                  eq(locations.shopId, tenant.shopId),
                  sql`${locations.id} = ANY(${sql.param([input.originId, input.destinationId])}::uuid[])`,
                ),
              )
          ).map((location) => [location.id, location]),
        );
        for (const [key, id] of [
          ['originId', input.originId],
          ['destinationId', input.destinationId],
        ] as const) {
          const location = found.get(id);
          if (!location) {
            errors.push({
              field: ['input', key],
              code: 'NOT_FOUND',
              message: 'Location not found',
            });
          } else if (!location.isActive) {
            errors.push({
              field: ['input', key],
              code: 'INVALID',
              message: 'The location is not active',
            });
          }
        }
        const snapshots = await this.variants.snapshotsOf(
          tx,
          tenant.shopId,
          lines.map((line) => line.variantId),
        );
        for (const line of lines) {
          if (!snapshots.has(line.variantId)) {
            errors.push({
              field: line.itemField,
              code: 'NOT_FOUND',
              message: 'Inventory item not found',
            });
          }
        }
        if (errors.length > 0) return { ok: false, errors };

        const id = newId();
        const origin = found.get(input.originId)!.name;
        await this.inventory.changeIn(
          tx,
          tenant,
          {
            name: 'available',
            reason: TRANSFER_REASONS.send,
            referenceDocumentUri: transferUri(id),
          },
          lines,
          (level, line, problems) => {
            if (level.available < line.quantity) {
              problems.push({
                field: [...line.field, 'quantity'],
                code: 'INVALID',
                message:
                  `Only ${Math.max(0, level.available)} available at ${origin}; ` +
                  `can't send ${line.quantity}`,
              });
              return null;
            }
            return { level, onHand: -line.quantity, committed: 0, reserved: 0, safetyStock: 0 };
          },
        );
        // The number is taken last, so that the counter row is locked briefly.
        const { rows } = await tx.execute<{ number: number }>(sql`
          INSERT INTO inventory.transfer_counters AS c (shop_id, next_number)
          VALUES (${tenant.shopId}, 2)
          ON CONFLICT (shop_id) DO UPDATE SET next_number = c.next_number + 1
          RETURNING next_number - 1 AS number`);
        await tx.insert(transfers).values({
          shopId: tenant.shopId,
          id,
          number: rows[0]!.number,
          originId: input.originId,
          destinationId: input.destinationId,
          reference,
          note,
        });
        await tx.insert(transferLines).values(
          lines.map((line, position) => {
            const snapshot = snapshots.get(line.variantId)!;
            return {
              shopId: tenant.shopId,
              transferId: id,
              id: newId(),
              position,
              variantId: line.variantId,
              productTitle: snapshot.productTitle,
              variantTitle: snapshot.variantTitle,
              sku: snapshot.sku,
              quantity: line.quantity,
            };
          }),
        );
        const [created] = await this.#load(tx, tenant.shopId, { ids: [id] });
        return { ok: true, value: created! };
      }),
    );
  }

  /**
   * Stock that arrived: each line's quantity added to on hand at the destination, in one
   * adjustment naming the transfer, never more than is still on its way. Received in full, the
   * transfer is received.
   */
  async receive(
    tenant: TenantContext,
    id: string,
    input: TransferReceiveInput,
  ): Promise<MutationResult<TransferRecord>> {
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
        const transfer = await this.#lockOpen(tx, tenant.shopId, id);
        if (!transfer.ok) return transfer;
        const lines = await this.#lines(tx, tenant.shopId, id);
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
              message: `Only ${left} still on the way of ${line.quantity}; can't receive ${wanted.quantity}`,
            });
            return [];
          }
          return [
            {
              lineId: line.id,
              variantId: line.variantId,
              locationId: transfer.value.destinationId,
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
          {
            name: 'available',
            reason: TRANSFER_REASONS.receive,
            referenceDocumentUri: transferUri(id),
          },
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
        await this.#addReceived(tx, tenant.shopId, targets);
        await tx.execute(sql`
          WITH done AS (
            SELECT NOT EXISTS (
                     SELECT 1 FROM inventory.transfer_lines l
                      WHERE l.shop_id = ${tenant.shopId} AND l.transfer_id = ${id}
                        AND l.received < l.quantity) AS all_came
          )
          UPDATE inventory.transfers t
             SET status = CASE WHEN done.all_came THEN 'received' ELSE 'in_transit' END,
                 closed_at = CASE WHEN done.all_came THEN now() END,
                 version = t.version + 1,
                 updated_at = now()
            FROM done
           WHERE t.shop_id = ${tenant.shopId} AND t.id = ${id}`);
        const [received] = await this.#load(tx, tenant.shopId, { ids: [id] });
        return { ok: true, value: received! };
      }),
    );
  }

  /**
   * Cancels what has not arrived: it goes back on hand where it left, in one adjustment naming the
   * transfer, and the transfer is cancelled. What arrived stays where it is.
   */
  async cancel(tenant: TenantContext, id: string): Promise<MutationResult<TransferRecord>> {
    return rollbackResult(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        const transfer = await this.#lockOpen(tx, tenant.shopId, id);
        if (!transfer.ok) return transfer;
        const targets = [...(await this.#lines(tx, tenant.shopId, id)).values()]
          .filter((line) => line.received < line.quantity)
          .map((line) => ({
            variantId: line.variantId,
            locationId: transfer.value.originId,
            field: ['id'],
            itemField: ['id'],
            quantity: line.quantity - line.received,
          }));
        if (targets.length > 0) {
          await this.inventory.changeIn(
            tx,
            tenant,
            {
              name: 'available',
              reason: TRANSFER_REASONS.cancel,
              referenceDocumentUri: transferUri(id),
            },
            targets,
            (level, target, problems) =>
              levelChange(problems, ['id'], level, 'available', target.quantity),
          );
        }
        await tx
          .update(transfers)
          .set({
            status: 'cancelled',
            closedAt: sql`now()`,
            version: sql`${transfers.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(transfers.shopId, tenant.shopId), eq(transfers.id, id)));
        const [cancelled] = await this.#load(tx, tenant.shopId, { ids: [id] });
        return { ok: true, value: cancelled! };
      }),
    );
  }

  /** The transfer locked, if it is still on its way. */
  async #lockOpen(
    tx: Tx,
    shopId: string,
    id: string,
  ): Promise<MutationResult<{ originId: string; destinationId: string }>> {
    const [transfer] = await tx
      .select({
        status: transfers.status,
        originId: transfers.originId,
        destinationId: transfers.destinationId,
      })
      .from(transfers)
      .where(and(eq(transfers.shopId, shopId), eq(transfers.id, id)))
      .for('update');
    if (!transfer) return failOne(['id'], 'NOT_FOUND', 'Transfer not found');
    if (transfer.status !== 'in_transit') {
      return failOne(['id'], 'INVALID', `The transfer is ${transfer.status} already`);
    }
    return { ok: true, value: transfer };
  }

  async #lines(tx: Tx, shopId: string, id: string) {
    const rows = await tx
      .select()
      .from(transferLines)
      .where(and(eq(transferLines.shopId, shopId), eq(transferLines.transferId, id)));
    return new Map(rows.map((line) => [line.id, line]));
  }

  async #addReceived(
    tx: Tx,
    shopId: string,
    targets: readonly { lineId: string; quantity: number }[],
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE inventory.transfer_lines l
         SET received = l.received + r.quantity
        FROM unnest(${sql.param(targets.map((target) => target.lineId))}::uuid[],
                    ${sql.param(targets.map((target) => target.quantity))}::int[])
             AS r(id, quantity)
       WHERE l.shop_id = ${shopId} AND l.id = r.id`);
  }

  /** Transfers with their locations and lines, the newest first. */
  async #load(
    tx: Tx,
    shopId: string,
    filter: {
      ids?: string[];
      first?: number;
      afterNumber?: number | null;
      status?: TransferStatusValue | null;
      locationId?: string | null;
    },
  ): Promise<TransferRecord[]> {
    const { rows } = await tx.execute<{
      id: string;
      number: number;
      status: TransferStatusValue;
      reference: string | null;
      note: string | null;
      closed_at: string | null;
      created_at: string;
      updated_at: string;
      origin: LocationJson;
      destination: LocationJson;
    }>(sql`
      SELECT t.id, t.number, t.status, t.reference, t.note, t.closed_at, t.created_at,
             t.updated_at, to_jsonb(o) AS origin, to_jsonb(d) AS destination
        FROM inventory.transfers t
        JOIN inventory.locations o ON o.shop_id = t.shop_id AND o.id = t.origin_id
        JOIN inventory.locations d ON d.shop_id = t.shop_id AND d.id = t.destination_id
       WHERE t.shop_id = ${shopId}
         ${filter.ids ? sql`AND t.id = ANY(${sql.param(filter.ids)}::uuid[])` : sql``}
         ${filter.status ? sql`AND t.status = ${filter.status}` : sql``}
         ${
           filter.locationId
             ? sql`AND (t.origin_id = ${filter.locationId} OR t.destination_id = ${filter.locationId})`
             : sql``
         }
         ${filter.afterNumber ? sql`AND t.number < ${filter.afterNumber}` : sql``}
       ORDER BY t.number DESC
       ${filter.first ? sql`LIMIT ${filter.first}` : sql``}`);
    if (rows.length === 0) return [];
    const lines = await tx
      .select()
      .from(transferLines)
      .where(
        and(
          eq(transferLines.shopId, shopId),
          sql`${transferLines.transferId} = ANY(${sql.param(rows.map((row) => row.id))}::uuid[])`,
        ),
      )
      .orderBy(asc(transferLines.position));
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      origin: locationFromJson(row.origin),
      destination: locationFromJson(row.destination),
      reference: row.reference,
      note: row.note,
      closedAt: row.closed_at === null ? null : toDate(row.closed_at),
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
      lines: lines
        .filter((line) => line.transferId === row.id)
        .map((line) => ({
          id: line.id,
          variantId: line.variantId,
          productTitle: line.productTitle,
          variantTitle: line.variantTitle,
          sku: line.sku,
          quantity: line.quantity,
          received: line.received,
        })),
    }));
  }
}
