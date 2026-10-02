import { Database } from '@hatti/db';
import type { Logger } from '@hatti/logger';
import {
  CourierAccountService,
  CourierBookingService,
  Couriers,
  courierShipmentOf,
  type ClaimedBooking,
  type CourierParcelStatusValue,
  type OpenedCourierAccount,
  type TrackedBooking,
} from '@hatti/logistics/public';
import { FulfillmentService, orderShipmentFactsIn } from '@hatti/orders/public';
import { repeat } from './repeat.js';

/** Bookings a round books for a shop, and parcels it asks about. */
const BOOK_BATCH = 20;
const TRACK_BATCH = 100;
/** How long a claimed booking is the claimer's: longer than a courier's slowest answers. */
const LEASE_MS = 5 * 60_000;
/** A booking the courier could not take for now is tried this long, and then fails. */
export const BOOKING_GIVE_UP_MS = 24 * 3_600_000;
/** Parcels their courier said nothing of are asked about again after this. */
const SILENT_MS = 3 * 3_600_000;
/** Parcels whose courier could not be asked are asked about again after this. */
const UNREACHABLE_MS = 3_600_000;

/** How long until a booking the courier could not take is tried again: a minute, doubling, at most an hour. */
export function bookingRetryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 60_000, 3_600_000);
}

export interface CourierBookingsOptions {
  database: Database;
  bookings: CourierBookingService;
  accounts: CourierAccountService;
  couriers: Couriers;
  fulfillments: FulfillmentService;
  logger?: Logger;
}

/**
 * Books orders with their couriers and follows their parcels (SHP-02, SHP-04, ADR-149). A
 * booking is booked with the courier, its tracking number kept at once, and the order shipped as
 * a parcel with it; a courier that cannot take it for now is asked again, for a day. Booked
 * parcels are asked about as often as where they are calls for (06 §5.3): what the courier says
 * is kept, and a parcel it says is delivered, or coming back, is marked so, which tells the
 * customer as any change of the parcel does.
 */
export class CourierBookings {
  constructor(private readonly options: CourierBookingsOptions) {}

  /** One round: every shop with bookings due books them, then asks about its parcels due. */
  async sweep(at: Date = new Date()): Promise<{ booked: number; tracked: number }> {
    const shops = await this.options.bookings.dueShops(at);
    let booked = 0;
    let tracked = 0;
    for (const shopId of shops) {
      try {
        booked += await this.book(shopId, at);
        tracked += await this.track(shopId, at);
      } catch (error) {
        // One shop's failure is not the others': its bookings are due again after their lease.
        this.options.logger?.warn({ err: error, shopId }, 'courier bookings not done');
      }
    }
    return { booked, tracked };
  }

  /** Books the shop's bookings due at `at`, a batch of them. How many were booked. */
  async book(shopId: string, at: Date): Promise<number> {
    const claimed = await this.options.bookings.claimToBook(shopId, at, BOOK_BATCH, LEASE_MS);
    const accounts = new Map<string, OpenedCourierAccount | null>();
    let booked = 0;
    for (const booking of claimed) {
      if (!accounts.has(booking.accountId)) {
        accounts.set(
          booking.accountId,
          await this.options.accounts.openedOf(shopId, booking.accountId),
        );
      }
      if (await this.#bookOne(shopId, booking, accounts.get(booking.accountId) ?? null, at)) {
        booked += 1;
      }
    }
    return booked;
  }

  /** Asks couriers about the shop's parcels due at `at`, a batch of them. How many they told of. */
  async track(shopId: string, at: Date): Promise<number> {
    const { bookings, accounts, couriers, logger } = this.options;
    const due = await bookings.claimToTrack(shopId, at, TRACK_BATCH, LEASE_MS);
    const byAccount = new Map<string, TrackedBooking[]>();
    for (const parcel of due) {
      byAccount.set(parcel.accountId, [...(byAccount.get(parcel.accountId) ?? []), parcel]);
    }
    let tracked = 0;
    for (const [accountId, parcels] of byAccount) {
      const ids = parcels.map((parcel) => parcel.id);
      const account = await accounts.openedOf(shopId, accountId);
      const adapter = account && couriers.of(account.courier);
      if (!account || !adapter) {
        await bookings.trackLater(shopId, ids, new Date(at.getTime() + 24 * 3_600_000));
        continue;
      }
      const answer = await adapter.track(
        account.credentials,
        parcels.map((parcel) => parcel.trackingNumber),
      );
      if (!answer.ok) {
        logger?.warn(
          { shopId, accountId, parcels: parcels.length },
          `${adapter.info.name} not asked about parcels: ${answer.message}`,
        );
        await bookings.trackLater(shopId, ids, new Date(at.getTime() + UNREACHABLE_MS));
        continue;
      }
      const said = new Map(answer.value.map((each) => [each.trackingNumber, each.status]));
      const silent: string[] = [];
      for (const parcel of parcels) {
        const status = said.get(parcel.trackingNumber);
        if (status === undefined) {
          silent.push(parcel.id);
          continue;
        }
        const { from, to } = await bookings.recordTracking(shopId, parcel, {
          courierStatus: status,
          at,
        });
        tracked += 1;
        if (to !== null && to !== from && parcel.fulfillmentId) {
          await this.#follow(shopId, parcel.fulfillmentId, to);
        }
      }
      await bookings.trackLater(shopId, silent, new Date(at.getTime() + SILENT_MS));
    }
    return tracked;
  }

  /** Books and settles, now, every `intervalMs`, a round never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.options.logger?.warn({ err: error }, 'courier bookings sweep failed'),
    );
  }

  /** Books one order with its courier and ships it. Whether it was booked. */
  async #bookOne(
    shopId: string,
    booking: ClaimedBooking,
    account: OpenedCourierAccount | null,
    at: Date,
  ): Promise<boolean> {
    const { bookings, couriers, database, fulfillments, logger } = this.options;
    const adapter = account && couriers.of(account.courier);
    if (!account || !adapter) {
      await bookings.markFailed(
        shopId,
        booking.id,
        account ? 'Shops no longer book with this courier here' : 'Its courier account is gone',
      );
      return false;
    }
    const order = await database.tenant(shopId, (tx) =>
      orderShipmentFactsIn(tx, shopId, booking.orderId),
    );
    if (!order) {
      await bookings.markFailed(shopId, booking.id, 'The order is gone');
      return false;
    }
    let trackingNumber = booking.trackingNumber;
    if (trackingNumber !== null) {
      // The courier booked it on a try that stopped before it was settled: ship it, unless it
      // shipped then.
      const shipped = order.parcels.find((parcel) => parcel.trackingNumber === trackingNumber);
      if (shipped) {
        await bookings.markBooked(shopId, booking.id, { fulfillmentId: shipped.id, at });
        return true;
      }
    } else {
      if (order.refusal) {
        await bookings.markFailed(shopId, booking.id, order.refusal);
        return false;
      }
      const city = await bookings.courierCityOf(shopId, account.courier, order.address?.city ?? '');
      const shipment = courierShipmentOf(order, { city, pickupCode: account.pickupCode });
      if ('refusal' in shipment) {
        await bookings.markFailed(shopId, booking.id, shipment.refusal);
        return false;
      }
      const answer = await adapter.book(account.credentials, shipment);
      if (!answer.ok) {
        const late = at.getTime() - booking.createdAt.getTime() >= BOOKING_GIVE_UP_MS;
        if (answer.retry && !late) {
          const next = new Date(at.getTime() + bookingRetryDelayMs(booking.attempts));
          await bookings.retryLater(shopId, booking.id, answer.message, next);
        } else {
          await bookings.markFailed(shopId, booking.id, answer.message);
        }
        return false;
      }
      trackingNumber = answer.value.trackingNumber;
      const kept = await bookings.recordTrackingNumber(
        shopId,
        booking.id,
        trackingNumber,
        shipment.codAmount,
      );
      if (!kept) {
        // Cancelled while the courier booked it: the courier's booking is cancelled too.
        const cancelled = await adapter.cancel(account.credentials, trackingNumber);
        if (!cancelled.ok) {
          logger?.warn(
            { shopId, bookingId: booking.id, trackingNumber },
            `${adapter.info.name} booking of a cancelled booking not cancelled: ${cancelled.message}`,
          );
        }
        return false;
      }
    }
    const shipped = await fulfillments.fulfill({ shopId, actor: 'system' }, order.id, {
      tracking: { company: adapter.info.name, number: trackingNumber },
    });
    if (!shipped.ok) {
      // The order changed while the courier booked it: the courier's booking is cancelled.
      const why = shipped.errors[0]?.message ?? 'The order could not ship';
      const cancelled = await adapter.cancel(account.credentials, trackingNumber);
      await bookings.markFailed(
        shopId,
        booking.id,
        cancelled.ok
          ? `${why}; its booking ${trackingNumber} with ${adapter.info.name} was cancelled`
          : `${why}; cancel its booking ${trackingNumber} with ${adapter.info.name}: ${cancelled.message}`,
      );
      return false;
    }
    await bookings.markBooked(shopId, booking.id, {
      fulfillmentId: shipped.value.fulfillmentId,
      at,
    });
    return true;
  }

  /** Marks the parcel as its courier says: delivered, or coming back. */
  async #follow(
    shopId: string,
    fulfillmentId: string,
    to: CourierParcelStatusValue,
  ): Promise<void> {
    const { fulfillments, logger } = this.options;
    const caller = { shopId, actor: 'system' as const };
    const result =
      to === 'delivered'
        ? await fulfillments.markDelivered(caller, fulfillmentId)
        : to === 'returning' || to === 'returned'
          ? await fulfillments.markReturning(caller, fulfillmentId)
          : null;
    if (result && !result.ok) {
      // Staff changed it otherwise, as a parcel checked back in: theirs stands.
      logger?.info(
        { shopId, fulfillmentId, to, errors: result.errors },
        'parcel not changed as its courier says',
      );
    }
  }
}
