import {
  InputChecker,
  actorColumnsOf,
  fail,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  CALLING_HOURS_LIMITS,
  clockOf,
  minutesOfClock,
  type CallingHoursValue,
} from './calling-hours.js';
import { OrderEvents, type OrderSettingsUpdatedPayload } from './events.js';
import type { CustomerCancellationValue } from './schema.js';

/** A shop's policies for its orders, but for risk. */
export interface OrderSettingsRecord {
  /** How long a cash-on-delivery customer may cancel their order through its link. */
  customerCancellation: CustomerCancellationValue;
  /**
   * When the Confirmation Desk calls customers, in the shop's time zone (COD-05, ADR-091); null
   * for any time.
   */
  callingHours: CallingHoursValue | null;
  /** How long an order may wait for its first call, in minutes of calling hours; null for any. */
  firstCallMinutes: number | null;
  /** Null while the shop has the defaults. */
  updatedAt: Date | null;
}

/** Fields left out stay as they are; null takes calling hours or the first-call target away. */
export interface OrderSettingsInput {
  customerCancellation?: CustomerCancellationValue;
  /** As clocks: "10:00" to "21:00". */
  callingHours?: { opens: string; closes: string } | null;
  firstCallMinutes?: number | null;
}

/**
 * The defaults: customers cancel until the order is packed, as a cancellation then costs the
 * shop nothing, and a parcel refused at the door a return.
 */
export const DEFAULT_ORDER_SETTINGS: Omit<OrderSettingsRecord, 'updatedAt'> = {
  customerCancellation: 'until_packed',
  callingHours: null,
  firstCallMinutes: null,
};

/** The shop's order settings, in the caller's transaction `tx`, or the defaults. */
export async function orderSettingsIn(tx: Tx, shopId: string): Promise<OrderSettingsRecord> {
  const { rows } = await tx.execute<{
    customer_cancellation: CustomerCancellationValue;
    calling_opens: number | null;
    calling_closes: number | null;
    first_call_minutes: number | null;
    updated_at: string;
  }>(sql`
    SELECT customer_cancellation, calling_opens, calling_closes, first_call_minutes, updated_at
      FROM orders.order_settings WHERE shop_id = ${shopId}`);
  const row = rows[0];
  if (!row) return { ...DEFAULT_ORDER_SETTINGS, updatedAt: null };
  return {
    customerCancellation: row.customer_cancellation,
    callingHours:
      row.calling_opens === null || row.calling_closes === null
        ? null
        : { opens: row.calling_opens, closes: row.calling_closes },
    firstCallMinutes: row.first_call_minutes,
    updatedAt: toDateOrNull(row.updated_at),
  };
}

/** The settings `input` makes of `current`, or null after adding what is wrong to `check`. */
function checkOrderSettings(
  check: InputChecker,
  current: OrderSettingsRecord,
  input: OrderSettingsInput,
): Omit<OrderSettingsRecord, 'updatedAt'> | null {
  const before = check.errors.length;
  let { callingHours, firstCallMinutes } = current;
  if (input.callingHours !== undefined) {
    callingHours = null;
    if (input.callingHours !== null) {
      const field = ['input', 'callingHours'];
      const opens = minutesOfClock(input.callingHours.opens);
      const closes = minutesOfClock(input.callingHours.closes);
      if (opens === null) {
        check.addMessage([...field, 'opens'], 'INVALID', 'Give a time of day, like 10:00');
      }
      if (closes === null) {
        check.addMessage([...field, 'closes'], 'INVALID', 'Give a time of day, like 21:00');
      }
      if (opens !== null && closes !== null) {
        if (closes - opens < CALLING_HOURS_LIMITS.minimumMinutes) {
          check.addMessage(
            field,
            'INVALID',
            'Calling hours close at least an hour after they open, on the same day',
          );
        } else {
          callingHours = { opens, closes };
        }
      }
    }
  }
  if (input.firstCallMinutes !== undefined) {
    firstCallMinutes = check.integer(
      ['input', 'firstCallMinutes'],
      input.firstCallMinutes,
      CALLING_HOURS_LIMITS.firstCallMinutes,
    );
  }
  if (check.errors.length > before) return null;
  return {
    customerCancellation: input.customerCancellation ?? current.customerCancellation,
    callingHours,
    firstCallMinutes,
  };
}

/** The settings as the event and the audit log say them. */
function settingsDetails(settings: Omit<OrderSettingsRecord, 'updatedAt'>) {
  return {
    customerCancellation: settings.customerCancellation,
    callingHours: settings.callingHours && {
      opens: clockOf(settings.callingHours.opens),
      closes: clockOf(settings.callingHours.closes),
    },
    firstCallMinutes: settings.firstCallMinutes,
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
      const check = new InputChecker();
      const next = checkOrderSettings(check, current, input);
      if (!next) return fail(check.errors);
      // Saving the defaults as they are makes them the shop's own.
      const given = Object.values(input).some((value) => value !== undefined);
      const details = settingsDetails(next);
      const unchanged = JSON.stringify(details) === JSON.stringify(settingsDetails(current));
      if (unchanged && (current.updatedAt !== null || !given)) return { ok: true, value: current };
      await tx.execute(sql`
        INSERT INTO orders.order_settings
               (shop_id, customer_cancellation, calling_opens, calling_closes, first_call_minutes)
        VALUES (${tenant.shopId}, ${next.customerCancellation}, ${next.callingHours?.opens ?? null},
                ${next.callingHours?.closes ?? null}, ${next.firstCallMinutes})
            ON CONFLICT (shop_id) DO UPDATE
                   SET customer_cancellation = excluded.customer_cancellation,
                       calling_opens = excluded.calling_opens,
                       calling_closes = excluded.calling_closes,
                       first_call_minutes = excluded.first_call_minutes,
                       version = orders.order_settings.version + 1, updated_at = now()`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<OrderSettingsUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderSettingsUpdated,
        aggregateType: 'order_settings',
        aggregateId: tenant.shopId,
        payload: { ...details, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'order_settings.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details,
      });
      return { ok: true, value: await orderSettingsIn(tx, tenant.shopId) };
    });
  }
}
