import { actorColumnsOf, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OrderEvents, type OrderSettingsUpdatedPayload } from './events.js';
import type { CustomerCancellationValue } from './schema.js';

/** A shop's policies for its orders, but for risk. */
export interface OrderSettingsRecord {
  /** How long a cash-on-delivery customer may cancel their order through its link. */
  customerCancellation: CustomerCancellationValue;
  /** Null while the shop has the defaults. */
  updatedAt: Date | null;
}

/** Fields left out stay as they are. */
export interface OrderSettingsInput {
  customerCancellation?: CustomerCancellationValue;
}

/**
 * The defaults: customers cancel until the order is packed, as a cancellation then costs the
 * shop nothing, and a parcel refused at the door a return.
 */
export const DEFAULT_ORDER_SETTINGS: Omit<OrderSettingsRecord, 'updatedAt'> = {
  customerCancellation: 'until_packed',
};

/** The shop's order settings, in the caller's transaction `tx`, or the defaults. */
export async function orderSettingsIn(tx: Tx, shopId: string): Promise<OrderSettingsRecord> {
  const { rows } = await tx.execute<{
    customer_cancellation: CustomerCancellationValue;
    updated_at: string;
  }>(sql`
    SELECT customer_cancellation, updated_at FROM orders.order_settings WHERE shop_id = ${shopId}`);
  const row = rows[0];
  if (!row) return { ...DEFAULT_ORDER_SETTINGS, updatedAt: null };
  return {
    customerCancellation: row.customer_cancellation,
    updatedAt: toDateOrNull(row.updated_at),
  };
}

/** A shop's policies for its orders, but for risk (05 §8). */
@Injectable()
export class OrderSettingsService {
  constructor(private readonly db: Database) {}

  get(tenant: TenantContext): Promise<OrderSettingsRecord> {
    return this.db.tenant(tenant.shopId, (tx) => orderSettingsIn(tx, tenant.shopId));
  }

  /** Changes the settings, for what customers do from now on. */
  async update(
    tenant: TenantContext,
    input: OrderSettingsInput,
  ): Promise<MutationResult<OrderSettingsRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await orderSettingsIn(tx, tenant.shopId);
      const next = {
        customerCancellation: input.customerCancellation ?? current.customerCancellation,
      };
      // Saving the defaults as they are makes them the shop's own.
      const given = input.customerCancellation !== undefined;
      const unchanged = next.customerCancellation === current.customerCancellation;
      if (unchanged && (current.updatedAt !== null || !given)) return { ok: true, value: current };
      await tx.execute(sql`
        INSERT INTO orders.order_settings (shop_id, customer_cancellation)
        VALUES (${tenant.shopId}, ${next.customerCancellation})
            ON CONFLICT (shop_id) DO UPDATE
                   SET customer_cancellation = excluded.customer_cancellation,
                       version = orders.order_settings.version + 1, updated_at = now()`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<OrderSettingsUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderSettingsUpdated,
        aggregateType: 'order_settings',
        aggregateId: tenant.shopId,
        payload: {
          customerCancellation: next.customerCancellation,
          actorKind: actor.actorKind,
          actorId: actor.actorId,
        },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'order_settings.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { customerCancellation: next.customerCancellation },
      });
      return { ok: true, value: await orderSettingsIn(tx, tenant.shopId) };
    });
  }
}
