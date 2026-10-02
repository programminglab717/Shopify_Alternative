import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, exactTime, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { orderShipmentFactsIn } from '@hatti/orders/public';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { COURIERS } from './courier-accounts.service.js';
import { Couriers, plainStatusOf, type CourierParcelStatusValue } from './couriers.js';
import {
  LogisticsEvents,
  type CourierBookingPayload,
  type ShipmentStatusChangedPayload,
} from './events.js';

/**
 * What became of a booking: waiting for the worker to book it, booked and shipped, failed, or
 * cancelled while it waited.
 */
export const BOOKING_STATUSES = ['pending', 'booked', 'failed', 'cancelled'] as const;
export type BookingStatusValue = (typeof BOOKING_STATUSES)[number];

export const BOOKING_LIMITS = {
  /** Orders booked at once, as other bulk actions take. */
  orders: 250,
} as const;

/** An order's booking with a courier, as the Admin API shows it. */
export interface CourierBookingRecord {
  id: string;
  orderId: string;
  orderNumber: number;
  accountId: string;
  courier: string;
  courierName: string;
  status: BookingStatusValue;
  /** Tries at booking it with the courier. */
  attempts: number;
  /** Why the last try failed, or why it was cancelled. */
  error: string | null;
  trackingNumber: string | null;
  /** Minor units: the cash the courier was asked to collect. */
  codAmount: bigint | null;
  /** The parcel shipped with the courier's tracking number. */
  fulfillmentId: string | null;
  /** What the courier last said of the parcel, as it said it, and what that means here. */
  courierStatus: string | null;
  parcelStatus: CourierParcelStatusValue | null;
  trackedAt: Date | null;
  requestedBy: { kind: 'staff' | 'app'; id: string };
  bookedAt: Date | null;
  createdAt: Date;
  /** When it was asked for, to the microsecond: where the next page starts. */
  createdAtExactly: string;
  updatedAt: Date;
}

export interface BookOrdersInput {
  orderIds: readonly string[];
  /** The shop's default account unless given. */
  accountId?: string | null;
}

/** What asking to book orders did: the bookings made, and the orders not booked, and why. */
export interface BookOrdersResult {
  bookings: CourierBookingRecord[];
  refused: { orderId: string; message: string }[];
}

export interface BookingListOptions {
  first: number;
  after?: { createdAt: string; id: string } | null;
  status?: BookingStatusValue | null;
  orderId?: string | null;
}

/** A booking the worker took to book with its courier. */
export interface ClaimedBooking {
  id: string;
  orderId: string;
  accountId: string;
  attempts: number;
  /** Set once the courier booked it, before the order shipped. */
  trackingNumber: string | null;
  createdAt: Date;
}

/** A booked parcel the worker took to ask its courier about. */
export interface TrackedBooking {
  id: string;
  orderId: string;
  accountId: string;
  trackingNumber: string;
  fulfillmentId: string | null;
  parcelStatus: CourierParcelStatusValue | null;
  bookedAt: Date;
}

/**
 * How long until a parcel is asked about again, by where it is (06 §5.3); null once nothing
 * more is to be heard. A status no mapping knows is asked about as one on its way.
 */
export const TRACK_EVERY_MS: Readonly<Record<CourierParcelStatusValue, number | null>> = {
  booked: 6 * 3_600_000,
  in_transit: 3 * 3_600_000,
  out_for_delivery: 30 * 60_000,
  attempted: 3_600_000,
  returning: 6 * 3_600_000,
  delivered: null,
  returned: null,
  lost: null,
  cancelled: null,
};

/** Parcels are followed this long after they are booked, and no longer. */
export const TRACK_FOR_MS = 60 * 24 * 3_600_000;

export type BookingRow = {
  id: string;
  order_id: string;
  order_number: number;
  account_id: string;
  courier: string;
  status: BookingStatusValue;
  attempts: number;
  error: string | null;
  tracking_number: string | null;
  cod_amount: string | null;
  fulfillment_id: string | null;
  courier_status: string | null;
  parcel_status: CourierParcelStatusValue | null;
  tracked_at: string | Date | null;
  requested_by_kind: 'staff' | 'app';
  requested_by_id: string;
  booked_at: string | Date | null;
  created_at: string | Date;
  created_at_exactly: string;
  updated_at: string | Date;
};

/** A booking's columns, with its account's courier, from {@link BOOKING_FROM}. */
export const BOOKING_COLUMNS = sql`
  b.id, b.order_id, b.order_number, b.account_id, a.courier, b.status, b.attempts, b.error,
  b.tracking_number, b.cod_amount::text AS cod_amount, b.fulfillment_id, b.courier_status,
  b.parcel_status, b.tracked_at, b.requested_by_kind, b.requested_by_id, b.booked_at,
  b.created_at, ${exactTime(sql`b.created_at`)} AS created_at_exactly, b.updated_at`;

export const BOOKING_FROM = sql`
  logistics.bookings b
  JOIN logistics.courier_accounts a ON a.shop_id = b.shop_id AND a.id = b.account_id`;

/**
 * Orders booked with couriers (SHP-02, SHP-04, ADR-149). Staff or an app ask for orders to be
 * booked, each on its own; a booking waits here until the worker books it with the courier, ships
 * the order as a parcel with the courier's tracking number, and then follows the parcel, so that
 * a courier slow or down never fails the request. An order is booked once at a time.
 */
@Injectable()
export class CourierBookingService {
  constructor(
    private readonly db: Database,
    @Inject(COURIERS) private readonly couriers: Couriers,
  ) {}

  /**
   * Asks for each order to be booked with the account, the shop's default unless given: those
   * that cannot be shipped now, or are being booked already, are refused, each with why.
   */
  async request(
    tenant: TenantContext,
    input: BookOrdersInput,
  ): Promise<MutationResult<BookOrdersResult>> {
    const check = new InputChecker();
    const orderIds = [...new Set(input.orderIds)];
    if (orderIds.length === 0) check.add(['orderIds'], 'BLANK', "can't be empty");
    if (orderIds.length > BOOKING_LIMITS.orders) {
      check.add(['orderIds'], 'TOO_MANY', `can list ${BOOKING_LIMITS.orders} orders at most`);
    }
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<BookOrdersResult>> => {
      const { rows: accounts } = await tx.execute<{
        id: string;
        courier: string;
        archived_at: string | Date | null;
      }>(sql`
        SELECT id, courier, archived_at FROM logistics.courier_accounts
         WHERE shop_id = ${tenant.shopId}
           AND ${input.accountId ? sql`id = ${input.accountId}` : sql`is_default`}`);
      const account = accounts[0];
      if (!account) {
        return input.accountId
          ? failOne(['accountId'], 'NOT_FOUND', 'Courier account not found')
          : failOne(['accountId'], 'BLANK', 'Connect a courier account first');
      }
      if (account.archived_at !== null) {
        return failOne(['accountId'], 'INVALID', 'The courier account is archived');
      }
      const courier = this.couriers.of(account.courier);
      if (!courier) {
        return failOne(['accountId'], 'INVALID', 'Shops no longer book with this courier here');
      }
      const requestedBy = actorColumnsOf(tenant.actor);
      const booked: string[] = [];
      const refused: BookOrdersResult['refused'] = [];
      for (const orderId of orderIds) {
        const facts = await orderShipmentFactsIn(tx, tenant.shopId, orderId);
        if (!facts) {
          refused.push({ orderId, message: 'Order not found' });
          continue;
        }
        const open = await openBookingIn(tx, tenant.shopId, orderId);
        if (open) {
          refused.push({
            orderId,
            message:
              open.status === 'pending'
                ? 'The order is waiting to be booked already'
                : `The order is booked already, as ${open.tracking_number}`,
          });
          continue;
        }
        if (facts.refusal) {
          refused.push({ orderId, message: facts.refusal });
          continue;
        }
        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO logistics.bookings (shop_id, order_id, order_number, account_id,
                                          requested_by_kind, requested_by_id)
          VALUES (${tenant.shopId}, ${orderId}, ${facts.number}, ${account.id},
                  ${requestedBy.actorKind}, ${requestedBy.actorId})
              ON CONFLICT DO NOTHING
          RETURNING id`);
        const id = rows[0]?.id;
        if (!id) {
          refused.push({ orderId, message: 'The order is waiting to be booked already' });
          continue;
        }
        await appendEvent<CourierBookingPayload>(tx, tenant.shopId, {
          type: LogisticsEvents.CourierBookingRequested,
          aggregateType: 'courier_booking',
          aggregateId: id,
          payload: { orderId, accountId: account.id, courier: account.courier },
        });
        booked.push(id);
      }
      const bookings = await bookingsIn(tx, tenant.shopId, booked);
      return {
        ok: true,
        value: { bookings: bookings.map((row) => this.#toRecord(row)), refused },
      };
    });
  }

  /** Cancels a booking while it waits; one booked is cancelled with the courier, not here. */
  async cancel(tenant: TenantContext, id: string): Promise<MutationResult<CourierBookingRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        order_id: string;
        account_id: string;
        courier: string;
      }>(sql`
        UPDATE logistics.bookings b
           SET status = 'cancelled', error = NULL, updated_at = now()
          FROM logistics.courier_accounts a
         WHERE b.shop_id = ${tenant.shopId} AND b.id = ${id} AND b.status = 'pending'
           AND b.tracking_number IS NULL
           AND a.shop_id = b.shop_id AND a.id = b.account_id
        RETURNING b.order_id, b.account_id, a.courier`);
      const cancelled = rows[0];
      if (!cancelled) {
        const [current] = await bookingsIn(tx, tenant.shopId, [id]);
        if (!current) return failOne(['id'], 'NOT_FOUND', 'Booking not found');
        return failOne(
          ['id'],
          'INVALID',
          current.status === 'pending'
            ? 'The courier is booking it now: cancel it with the courier once it is booked'
            : `Only a booking waiting can be cancelled: this one is ${current.status}`,
        );
      }
      await appendEvent<CourierBookingPayload>(tx, tenant.shopId, {
        type: LogisticsEvents.CourierBookingCancelled,
        aggregateType: 'courier_booking',
        aggregateId: id,
        payload: {
          orderId: cancelled.order_id,
          accountId: cancelled.account_id,
          courier: cancelled.courier,
        },
      });
      const [row] = await bookingsIn(tx, tenant.shopId, [id]);
      return { ok: true, value: this.#toRecord(row!) };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<CourierBookingRecord | null> {
    const [row] = await this.db.tenant(tenant.shopId, (tx) => bookingsIn(tx, tenant.shopId, [id]));
    return row ? this.#toRecord(row) : null;
  }

  /** The shop's bookings, the latest first, a page at a time. */
  async list(
    tenant: TenantContext,
    options: BookingListOptions,
  ): Promise<{ items: CourierBookingRecord[]; hasNextPage: boolean }> {
    const { after, status, orderId } = options;
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<BookingRow>(sql`
        SELECT ${BOOKING_COLUMNS}
          FROM ${BOOKING_FROM}
         WHERE b.shop_id = ${tenant.shopId}
           ${status ? sql`AND b.status = ${status}` : sql``}
           ${orderId ? sql`AND b.order_id = ${orderId}` : sql``}
           ${
             after
               ? sql`AND (b.created_at, b.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
               : sql``
           }
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT ${options.first + 1}`),
    );
    return {
      items: rows.slice(0, options.first).map((row) => this.#toRecord(row)),
      hasNextPage: rows.length > options.first,
    };
  }

  /**
   * The shops with bookings to book, or parcels to ask about, at `at`: found with the system
   * role, which sees all.
   */
  async dueShops(at: Date, limit = 100): Promise<string[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT shop_id FROM logistics.bookings
         WHERE status = 'pending' AND next_attempt_at <= ${at.toISOString()}
        UNION
        SELECT shop_id FROM logistics.bookings
         WHERE status = 'booked' AND next_track_at <= ${at.toISOString()}
         LIMIT ${limit}`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * Takes up to `limit` of the shop's bookings due at `at`, the longest waiting first, to book
   * them: each counts a try, and is not due again for `leaseMs` unless settled before. No two
   * workers take the same, and one that stops before settling has them tried again after that.
   */
  async claimToBook(
    shopId: string,
    at: Date,
    limit: number,
    leaseMs: number,
  ): Promise<ClaimedBooking[]> {
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{
        id: string;
        order_id: string;
        account_id: string;
        attempts: number;
        tracking_number: string | null;
        created_at: string | Date;
      }>(sql`
        -- Chosen once: a subquery in UPDATE's FROM may be run again, and take more.
        WITH due AS MATERIALIZED (
          SELECT id FROM logistics.bookings
           WHERE shop_id = ${shopId} AND status = 'pending'
             AND next_attempt_at <= ${at.toISOString()}
           ORDER BY next_attempt_at, id
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED)
        UPDATE logistics.bookings b
           SET attempts = b.attempts + 1,
               next_attempt_at = ${new Date(at.getTime() + leaseMs).toISOString()},
               updated_at = now()
          FROM due
         WHERE b.shop_id = ${shopId} AND b.id = due.id
        RETURNING b.id, b.order_id, b.account_id, b.attempts, b.tracking_number, b.created_at`),
    );
    return rows
      .map((row) => ({
        id: row.id,
        orderId: row.order_id,
        accountId: row.account_id,
        attempts: row.attempts,
        trackingNumber: row.tracking_number,
        createdAt: toDate(row.created_at),
      }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  }

  /**
   * Keeps the courier's tracking number as soon as it booked the order, before the order ships,
   * so that a try after a crash ships it rather than booking it twice. False if the booking was
   * cancelled meanwhile: the courier's is to be cancelled too.
   */
  async recordTrackingNumber(
    shopId: string,
    id: string,
    trackingNumber: string,
    codAmount: bigint,
  ): Promise<boolean> {
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{ id: string }>(sql`
        UPDATE logistics.bookings
           SET tracking_number = ${trackingNumber}, cod_amount = ${codAmount}, error = NULL,
               updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id} AND status = 'pending'
        RETURNING id`),
    );
    return rows.length > 0;
  }

  /** The order shipped as the parcel `fulfillmentId`: booked, and followed from `at`. */
  async markBooked(
    shopId: string,
    id: string,
    booked: { fulfillmentId: string; at: Date },
  ): Promise<void> {
    await this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{
        order_id: string;
        account_id: string;
        courier: string;
        tracking_number: string;
      }>(sql`
        UPDATE logistics.bookings b
           SET status = 'booked', fulfillment_id = ${booked.fulfillmentId},
               booked_at = ${booked.at.toISOString()}, parcel_status = 'booked',
               next_track_at = ${new Date(booked.at.getTime() + TRACK_EVERY_MS.booked!).toISOString()},
               error = NULL, updated_at = now()
          FROM logistics.courier_accounts a
         WHERE b.shop_id = ${shopId} AND b.id = ${id} AND b.status = 'pending'
           AND b.tracking_number IS NOT NULL
           AND a.shop_id = b.shop_id AND a.id = b.account_id
        RETURNING b.order_id, b.account_id, a.courier, b.tracking_number`);
      const row = rows[0];
      if (!row) return;
      await appendEvent<CourierBookingPayload>(tx, shopId, {
        type: LogisticsEvents.CourierBookingBooked,
        aggregateType: 'courier_booking',
        aggregateId: id,
        payload: {
          orderId: row.order_id,
          accountId: row.account_id,
          courier: row.courier,
          trackingNumber: row.tracking_number,
          fulfillmentId: booked.fulfillmentId,
        },
      });
    });
  }

  /** The booking failed for good, for `error`. */
  async markFailed(shopId: string, id: string, error: string): Promise<void> {
    await this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{
        order_id: string;
        account_id: string;
        courier: string;
      }>(sql`
        UPDATE logistics.bookings b
           SET status = 'failed', error = ${error.slice(0, 1_000)}, updated_at = now()
          FROM logistics.courier_accounts a
         WHERE b.shop_id = ${shopId} AND b.id = ${id} AND b.status = 'pending'
           AND a.shop_id = b.shop_id AND a.id = b.account_id
        RETURNING b.order_id, b.account_id, a.courier`);
      const row = rows[0];
      if (!row) return;
      await appendEvent<CourierBookingPayload>(tx, shopId, {
        type: LogisticsEvents.CourierBookingFailed,
        aggregateType: 'courier_booking',
        aggregateId: id,
        payload: {
          orderId: row.order_id,
          accountId: row.account_id,
          courier: row.courier,
          error: error.slice(0, 1_000),
        },
      });
    });
  }

  /** Tries the booking again at `nextAttemptAt`: the courier could not take it for now. */
  async retryLater(shopId: string, id: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE logistics.bookings
           SET next_attempt_at = ${nextAttemptAt.toISOString()}, error = ${error.slice(0, 1_000)},
               updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id} AND status = 'pending'`),
    );
  }

  /**
   * Takes up to `limit` of the shop's booked parcels due to be asked about at `at`, each not due
   * again for `leaseMs` unless recorded before.
   */
  async claimToTrack(
    shopId: string,
    at: Date,
    limit: number,
    leaseMs: number,
  ): Promise<TrackedBooking[]> {
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{
        id: string;
        order_id: string;
        account_id: string;
        tracking_number: string;
        fulfillment_id: string | null;
        parcel_status: CourierParcelStatusValue | null;
        booked_at: string | Date;
      }>(sql`
        WITH due AS MATERIALIZED (
          SELECT id FROM logistics.bookings
           WHERE shop_id = ${shopId} AND status = 'booked'
             AND next_track_at <= ${at.toISOString()}
           ORDER BY next_track_at, id
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED)
        UPDATE logistics.bookings b
           SET next_track_at = ${new Date(at.getTime() + leaseMs).toISOString()}
          FROM due
         WHERE b.shop_id = ${shopId} AND b.id = due.id
        RETURNING b.id, b.order_id, b.account_id, b.tracking_number, b.fulfillment_id,
                  b.parcel_status, b.booked_at`),
    );
    return rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      accountId: row.account_id,
      trackingNumber: row.tracking_number,
      fulfillmentId: row.fulfillment_id,
      parcelStatus: row.parcel_status,
      bookedAt: toDate(row.booked_at),
    }));
  }

  /**
   * Records what the courier said of the parcel at `at`, and when to ask again: a change of
   * where it is publishes shipment.status_changed. Its status as Hatti reads it, before and now;
   * the same when the courier's words mean nothing known.
   */
  async recordTracking(
    shopId: string,
    booking: TrackedBooking,
    said: { courierStatus: string; at: Date },
  ): Promise<{ from: CourierParcelStatusValue | null; to: CourierParcelStatusValue | null }> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows: accounts } = await tx.execute<{ courier: string }>(sql`
        SELECT courier FROM logistics.courier_accounts
         WHERE shop_id = ${shopId} AND id = ${booking.accountId}`);
      const courier = accounts[0]!.courier;
      const mapped = (await statusOfIn(tx, courier, said.courierStatus)) ?? booking.parcelStatus;
      const every = mapped === null ? TRACK_EVERY_MS.in_transit : TRACK_EVERY_MS[mapped];
      const until = booking.bookedAt.getTime() + TRACK_FOR_MS;
      const next =
        every === null || said.at.getTime() + every > until
          ? null
          : new Date(said.at.getTime() + every);
      await tx.execute(sql`
        UPDATE logistics.bookings
           SET courier_status = ${said.courierStatus.slice(0, 200)}, parcel_status = ${mapped},
               tracked_at = ${said.at.toISOString()},
               next_track_at = ${next?.toISOString() ?? null}, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${booking.id} AND status = 'booked'`);
      if (mapped !== null && mapped !== booking.parcelStatus) {
        await appendEvent<ShipmentStatusChangedPayload>(tx, shopId, {
          type: LogisticsEvents.ShipmentStatusChanged,
          aggregateType: 'courier_booking',
          aggregateId: booking.id,
          payload: {
            orderId: booking.orderId,
            fulfillmentId: booking.fulfillmentId,
            courier,
            trackingNumber: booking.trackingNumber,
            from: booking.parcelStatus,
            to: mapped,
            courierStatus: said.courierStatus.slice(0, 200),
          },
        });
      }
      return { from: booking.parcelStatus, to: mapped };
    });
  }

  /** Asks about the parcels again at `nextTrackAt`: their courier said nothing of them. */
  async trackLater(shopId: string, ids: readonly string[], nextTrackAt: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE logistics.bookings SET next_track_at = ${nextTrackAt.toISOString()}
         WHERE shop_id = ${shopId} AND id = ANY(${sql.param([...ids])}::uuid[])
           AND status = 'booked' AND next_track_at IS NOT NULL`),
    );
  }

  /** The courier's own name for `city`, where it has one; the city as Hatti names it otherwise. */
  async courierCityOf(shopId: string, courier: string, city: string): Promise<string> {
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{ courier_city: string }>(sql`
        SELECT courier_city FROM logistics.courier_cities
         WHERE courier = ${courier} AND lower(city) = lower(${city})`),
    );
    return rows[0]?.courier_city ?? city;
  }

  #toRecord(row: BookingRow): CourierBookingRecord {
    return bookingRecordOf(row, this.couriers);
  }
}

/** A booking's row as the Admin API shows it, its courier named as `couriers` name it. */
export function bookingRecordOf(row: BookingRow, couriers: Couriers): CourierBookingRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    accountId: row.account_id,
    courier: row.courier,
    courierName: couriers.of(row.courier)?.info.name ?? row.courier,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    trackingNumber: row.tracking_number,
    codAmount: row.cod_amount === null ? null : BigInt(row.cod_amount),
    fulfillmentId: row.fulfillment_id,
    courierStatus: row.courier_status,
    parcelStatus: row.parcel_status,
    trackedAt: toDateOrNull(row.tracked_at),
    requestedBy: { kind: row.requested_by_kind, id: row.requested_by_id },
    bookedAt: toDateOrNull(row.booked_at),
    createdAt: toDate(row.created_at),
    createdAtExactly: row.created_at_exactly,
    updatedAt: toDate(row.updated_at),
  };
}

/** The order's booking waiting or booked, if it has one. */
async function openBookingIn(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<{ status: BookingStatusValue; tracking_number: string | null } | null> {
  const { rows } = await tx.execute<{
    status: BookingStatusValue;
    tracking_number: string | null;
  }>(sql`
    SELECT status, tracking_number FROM logistics.bookings
     WHERE shop_id = ${shopId} AND order_id = ${orderId} AND status IN ('pending', 'booked')`);
  return rows[0] ?? null;
}

/** The bookings `ids` of the shop, as rows, the oldest first. */
export async function bookingsIn(
  tx: Tx,
  shopId: string,
  ids: readonly string[],
): Promise<BookingRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await tx.execute<BookingRow>(sql`
    SELECT ${BOOKING_COLUMNS}
      FROM ${BOOKING_FROM}
     WHERE b.shop_id = ${shopId} AND b.id = ANY(${sql.param([...ids])}::uuid[])
     ORDER BY b.created_at, b.id`);
  return rows;
}

/**
 * What the courier's `raw` status means here: its mapping (ADR-149), else a status written as
 * Hatti names its own; null when neither says.
 */
async function statusOfIn(
  tx: Tx,
  courier: string,
  raw: string,
): Promise<CourierParcelStatusValue | null> {
  const { rows } = await tx.execute<{ status: CourierParcelStatusValue }>(sql`
    SELECT status FROM logistics.courier_statuses
     WHERE courier = ${courier} AND raw = ${raw.trim().toLowerCase()}`);
  return rows[0]?.status ?? plainStatusOf(raw);
}
