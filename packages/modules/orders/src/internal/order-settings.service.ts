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
  /**
   * Days after an order was placed when, its customer unreachable, it is cancelled (COD-05,
   * ADR-092); null for never.
   */
  cancelUnreachableAfterDays: number | null;
  /**
   * Days after an order was placed when, its payment still awaited and no receipt of it waiting
   * to be checked, it is cancelled (ADR-168); null for never.
   */
  cancelUnpaidAfterDays: number | null;
  /** Null while the shop has the defaults. */
  updatedAt: Date | null;
}

/** Fields left out stay as they are; null takes calling hours or the first-call target away. */
export interface OrderSettingsInput {
  customerCancellation?: CustomerCancellationValue;
  /** As clocks: "10:00" to "21:00". */
  callingHours?: { opens: string; closes: string } | null;
  firstCallMinutes?: number | null;
  cancelUnreachableAfterDays?: number | null;
  cancelUnpaidAfterDays?: number | null;
}

export const UNPAID_LIMITS = {
  /** Days after an order was placed when, still unpaid, it may be cancelled. */
  days: { min: 1, max: 30 },
  /** Orders a sweep cancels for a shop at most, each in its own transaction. */
  batch: 100,
  /**
   * How long a payment started online may still be made: JazzCash's lasts a day (ADR-163). An
   * order with one started since is left for the next sweep.
   */
  paymentUnderwayMs: 24 * 3_600_000,
  /**
   * How long before an order is cancelled its customer is reminded to pay (ADR-174), and how long
   * after it was placed at the soonest.
   */
  reminderBeforeMs: 24 * 3_600_000,
  reminderAfterMs: 12 * 3_600_000,
} as const;

/** Asking a customer once more to confirm their order (COD-01, ADR-175). */
export const CONFIRMATION_REMINDER = {
  /** How long after an order was placed, unanswered, its customer is asked again. */
  afterMs: 3 * 3_600_000,
  /** Orders placed longer ago are not asked again: the shop calls, or gives up on them. */
  withinMs: 3 * 86_400_000,
  /** When a shop without calling hours asks: 9:00 to 21:00 in its time zone. */
  hours: { opens: 9 * 60, closes: 21 * 60 },
  /** Orders a sweep asks again for a shop at most, each in its own transaction. */
  batch: 100,
} as const;

export const UNREACHABLE_LIMITS = {
  /** Days after an order was placed when, its customer unreachable, it may be cancelled. */
  days: { min: 1, max: 30 },
  /** Orders a sweep cancels for a shop at most, each in its own transaction. */
  batch: 100,
} as const;

/**
 * The defaults: customers cancel until the order is packed, as a cancellation then costs the
 * shop nothing, and a parcel refused at the door a return.
 */
export const DEFAULT_ORDER_SETTINGS: Omit<OrderSettingsRecord, 'updatedAt'> = {
  customerCancellation: 'until_packed',
  callingHours: null,
  firstCallMinutes: null,
  cancelUnreachableAfterDays: null,
  cancelUnpaidAfterDays: null,
};

/** The shop's order settings, in the caller's transaction `tx`, or the defaults. */
export async function orderSettingsIn(tx: Tx, shopId: string): Promise<OrderSettingsRecord> {
  const { rows } = await tx.execute<{
    customer_cancellation: CustomerCancellationValue;
    calling_opens: number | null;
    calling_closes: number | null;
    first_call_minutes: number | null;
    cancel_unreachable_after_days: number | null;
    cancel_unpaid_after_days: number | null;
    updated_at: string;
  }>(sql`
    SELECT customer_cancellation, calling_opens, calling_closes, first_call_minutes,
           cancel_unreachable_after_days, cancel_unpaid_after_days, updated_at
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
    cancelUnreachableAfterDays: row.cancel_unreachable_after_days,
    cancelUnpaidAfterDays: row.cancel_unpaid_after_days,
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
  let { callingHours, firstCallMinutes, cancelUnreachableAfterDays, cancelUnpaidAfterDays } =
    current;
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
  if (input.cancelUnreachableAfterDays !== undefined) {
    cancelUnreachableAfterDays = check.integer(
      ['input', 'cancelUnreachableAfterDays'],
      input.cancelUnreachableAfterDays,
      UNREACHABLE_LIMITS.days,
    );
  }
  if (input.cancelUnpaidAfterDays !== undefined) {
    cancelUnpaidAfterDays = check.integer(
      ['input', 'cancelUnpaidAfterDays'],
      input.cancelUnpaidAfterDays,
      UNPAID_LIMITS.days,
    );
  }
  if (check.errors.length > before) return null;
  return {
    customerCancellation: input.customerCancellation ?? current.customerCancellation,
    callingHours,
    firstCallMinutes,
    cancelUnreachableAfterDays,
    cancelUnpaidAfterDays,
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
    cancelUnreachableAfterDays: settings.cancelUnreachableAfterDays,
    cancelUnpaidAfterDays: settings.cancelUnpaidAfterDays,
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
               (shop_id, customer_cancellation, calling_opens, calling_closes, first_call_minutes,
                cancel_unreachable_after_days, cancel_unpaid_after_days)
        VALUES (${tenant.shopId}, ${next.customerCancellation}, ${next.callingHours?.opens ?? null},
                ${next.callingHours?.closes ?? null}, ${next.firstCallMinutes},
                ${next.cancelUnreachableAfterDays}, ${next.cancelUnpaidAfterDays})
            ON CONFLICT (shop_id) DO UPDATE
                   SET customer_cancellation = excluded.customer_cancellation,
                       calling_opens = excluded.calling_opens,
                       calling_closes = excluded.calling_closes,
                       first_call_minutes = excluded.first_call_minutes,
                       cancel_unreachable_after_days = excluded.cancel_unreachable_after_days,
                       cancel_unpaid_after_days = excluded.cancel_unpaid_after_days,
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
