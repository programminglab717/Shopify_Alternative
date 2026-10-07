import {
  InputChecker,
  actorColumnsOf,
  fail,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { ObjectStorage } from '@hatti/storage';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  BOOKING_COLUMNS,
  BOOKING_FROM,
  bookingRecordOf,
  type BookingRow,
  type CourierBookingRecord,
} from './bookings.service.js';
import { COURIERS, CourierAccountService } from './courier-accounts.service.js';
import type { CourierAdapter, CourierPickup, CourierResult, Couriers } from './couriers.js';
import { LogisticsEvents, type CourierPickupPayload } from './events.js';

/**
 * Parcels one pickup hands over at most, the longest waiting first, the rest in the next; and how
 * long a rider's name and code may be.
 */
export const PICKUP_LIMITS = { parcels: 200, rider: 100, listed: 50 } as const;

/** How long the URL of a courier's load sheet lasts: an hour. */
const SHEET_URL_SECONDS = 3_600;

/** A pickup asked of its courier and never answered, as when the process stopped, lets its parcels go after this long. */
const UNANSWERED = '10 minutes';

/** A parcel still waiting this long after the pickup it went in is handed over in the next. */
const MISSED = '24 hours';

export type PickupStatusValue = 'requesting' | 'requested' | 'failed';

/** A pickup of an account's parcels, as staff see it (ADR-253). */
export interface CourierPickupRecord {
  id: string;
  accountId: string;
  courier: string;
  courierName: string;
  /** Being asked of the courier; asked; or refused, its parcels left for the next. */
  status: PickupStatusValue;
  parcelCount: number;
  /** The courier's number for its load sheet; null where it gives none. */
  reference: string | null;
  /** Who took the parcels, where the courier asked. */
  rider: { name: string; code: string } | null;
  /** Where the courier's own load sheet is kept; null where it gave none. */
  documentKey: string | null;
  /** What the courier said when it refused. */
  error: string | null;
  requestedBy: { kind: 'staff' | 'app'; id: string };
  /** When the courier took it; null until it did. */
  requestedAt: Date | null;
  createdAt: Date;
}

export interface CourierPickupInput {
  /** The account whose parcels go; the shop's default unless given. */
  accountId?: string | null;
  /** Who takes them, where the courier asks: the rider's name and code, as it gave them. */
  riderName?: string | null;
  riderCode?: string | null;
}

/** The parcels claimed for a pickup, before its courier is asked. */
interface Claim {
  pickupId: string;
  account: { id: string; courier: string; pickup_code: string | null };
  adapter: CourierAdapter;
  rider: { name: string; code: string } | null;
  trackingNumbers: string[];
}

type PickupRow = {
  id: string;
  account_id: string;
  courier: string;
  status: PickupStatusValue;
  parcel_count: number;
  reference: string | null;
  rider_name: string | null;
  rider_code: string | null;
  document_key: string | null;
  error: string | null;
  requested_by_kind: 'staff' | 'app';
  requested_by_id: string;
  requested_at: string | Date | null;
  created_at: string | Date;
};

const PICKUP_COLUMNS = sql`
  p.id, p.account_id, a.courier, p.status, p.parcel_count, p.reference, p.rider_name,
  p.rider_code, p.document_key, p.error, p.requested_by_kind, p.requested_by_id, p.requested_at,
  p.created_at`;

const PICKUP_FROM = sql`
  logistics.pickups p
  JOIN logistics.courier_accounts a ON a.shop_id = p.shop_id AND a.id = p.account_id`;

/**
 * Pickups (SHP-02, ADR-253): an account's parcels waiting to be picked up are handed to its
 * courier through the courier's API, PostEx's load sheet for its pickup address and Leopards'
 * with the rider who takes them. The parcels are claimed in a transaction, the courier is asked
 * outside any, and the pickup is kept as the courier answered: with its number for the sheet and
 * the sheet itself where it gives them, or refused, its parcels left for the next.
 */
@Injectable()
export class CourierPickupService {
  constructor(
    private readonly db: Database,
    @Inject(COURIERS) private readonly couriers: Couriers,
    private readonly accounts: CourierAccountService,
    /** Where couriers' own load sheets are kept; without it, as in some tests, none is. */
    @Optional() private readonly storage?: ObjectStorage,
  ) {}

  /**
   * Hands the account's parcels waiting to be picked up to its courier, the longest waiting
   * first, up to {@link PICKUP_LIMITS}: those not in a pickup yet, and those still waiting a day
   * after the one they went in. Refused with why where the courier takes no pickups through its
   * API, asks for its rider, or refuses them.
   */
  async request(
    tenant: TenantContext,
    input: CourierPickupInput,
  ): Promise<MutationResult<CourierPickupRecord>> {
    const check = new InputChecker();
    const riderName = check.text(['riderName'], input.riderName, { max: PICKUP_LIMITS.rider });
    const riderCode = check.text(['riderCode'], input.riderCode, { max: PICKUP_LIMITS.rider });
    if (!check.ok) return fail(check.errors);
    const { shopId } = tenant;
    const requestedBy = actorColumnsOf(tenant.actor);
    const claimed = await this.db.tenant(shopId, async (tx): Promise<MutationResult<Claim>> => {
      // One pickup of an account's parcels at a time.
      const { rows: accounts } = await tx.execute<{
        id: string;
        courier: string;
        pickup_code: string | null;
      }>(sql`
        SELECT id, courier, pickup_code FROM logistics.courier_accounts
         WHERE shop_id = ${shopId}
           AND ${input.accountId ? sql`id = ${input.accountId}` : sql`is_default`}
           FOR UPDATE`);
      const account = accounts[0];
      if (!account) {
        return input.accountId
          ? failOne(['accountId'], 'NOT_FOUND', 'Courier account not found')
          : failOne(['accountId'], 'BLANK', 'Connect a courier account first');
      }
      const adapter = this.couriers.of(account.courier);
      const name = adapter?.info.name ?? account.courier;
      if (!adapter?.pickup || !adapter.info.pickups) {
        return failOne(
          ['accountId'],
          'INVALID',
          `${name} takes no pickups through its API: print the account's load sheet for its rider`,
        );
      }
      const rider = riderName && riderCode ? { name: riderName, code: riderCode } : null;
      if (adapter.info.pickups.rider && !rider) {
        const missing = new InputChecker();
        if (!riderName)
          missing.addMessage(['riderName'], 'BLANK', `${name} asks for its rider's name`);
        if (!riderCode)
          missing.addMessage(['riderCode'], 'BLANK', `${name} asks for its rider's code`);
        return fail(missing.errors);
      }
      // Asked before and never answered: refused, so its parcels go in this one.
      await tx.execute(sql`
        UPDATE logistics.pickups SET status = 'failed', error = 'The courier never answered'
         WHERE shop_id = ${shopId} AND account_id = ${account.id} AND status = 'requesting'
           AND created_at < now() - ${UNANSWERED}::interval`);
      const { rows } = await tx.execute<{ id: string; tracking_number: string }>(sql`
        SELECT b.id, b.tracking_number FROM logistics.bookings b
         WHERE b.shop_id = ${shopId} AND b.account_id = ${account.id}
           AND b.status = 'booked' AND b.parcel_status = 'booked'
           AND b.tracking_number IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM logistics.pickup_parcels pp
               JOIN logistics.pickups p ON p.shop_id = pp.shop_id AND p.id = pp.pickup_id
              WHERE pp.shop_id = b.shop_id AND pp.booking_id = b.id
                AND (p.status = 'requesting'
                     OR (p.status = 'requested'
                         AND p.requested_at > now() - ${MISSED}::interval)))
         ORDER BY b.booked_at, b.id
         LIMIT ${PICKUP_LIMITS.parcels}`);
      if (rows.length === 0) {
        return failOne(
          ['accountId'],
          'INVALID',
          "None of this account's parcels waits to be picked up",
        );
      }
      const { rows: made } = await tx.execute<{ id: string }>(sql`
        INSERT INTO logistics.pickups (shop_id, account_id, parcel_count, rider_name, rider_code,
                                       requested_by_kind, requested_by_id)
        VALUES (${shopId}, ${account.id}, ${rows.length}, ${rider?.name ?? null},
                ${rider?.code ?? null}, ${requestedBy.actorKind}, ${requestedBy.actorId})
        RETURNING id`);
      const pickupId = made[0]!.id;
      await tx.execute(sql`
        INSERT INTO logistics.pickup_parcels (shop_id, pickup_id, booking_id)
        SELECT ${shopId}, ${pickupId}, id
          FROM unnest(${sql.param(rows.map((row) => row.id))}::uuid[]) AS id`);
      return {
        ok: true,
        value: {
          pickupId,
          account,
          adapter,
          rider,
          trackingNumbers: rows.map((row) => row.tracking_number),
        },
      };
    });
    if (!claimed.ok) return claimed;
    const { pickupId, account, adapter, rider, trackingNumbers } = claimed.value;

    let answer: CourierResult<CourierPickup>;
    try {
      const opened = await this.accounts.openedOf(shopId, account.id);
      answer = opened
        ? await adapter.pickup!(opened.credentials, {
            trackingNumbers,
            pickupCode: account.pickup_code,
            rider,
          })
        : { ok: false, retry: false, message: 'Courier account not found' };
    } catch (error) {
      await this.#refused(shopId, pickupId, 'Hatti could not ask the courier');
      throw error;
    }
    if (!answer.ok) {
      await this.#refused(shopId, pickupId, answer.message);
      return failOne(['accountId'], answer.retry ? 'UNAVAILABLE' : 'INVALID', answer.message);
    }

    // The courier took the parcels: its sheet is kept, if it can be; else its portal prints it.
    let documentKey: string | null = null;
    if (answer.value.document && this.storage) {
      const key = `shops/${shopId}/pickups/${pickupId}.pdf`;
      try {
        await this.storage.put(key, answer.value.document, 'application/pdf');
        documentKey = key;
      } catch {
        documentKey = null;
      }
    }
    const reference = answer.value.reference?.slice(0, 100) ?? null;
    return this.db.tenant(shopId, async (tx) => {
      await tx.execute(sql`
        UPDATE logistics.pickups
           SET status = 'requested', reference = ${reference}, document_key = ${documentKey},
               requested_at = now()
         WHERE shop_id = ${shopId} AND id = ${pickupId}`);
      await appendEvent<CourierPickupPayload>(tx, shopId, {
        type: LogisticsEvents.CourierPickupRequested,
        aggregateType: 'courier_pickup',
        aggregateId: pickupId,
        payload: {
          accountId: account.id,
          courier: account.courier,
          parcelCount: trackingNumbers.length,
          reference,
        },
      });
      return { ok: true, value: (await this.#pickupIn(tx, shopId, pickupId))! };
    });
  }

  /** The shop's pickups, the latest first, of one account if given. */
  async list(
    tenant: TenantContext,
    options: { accountId?: string | null; first: number },
  ): Promise<CourierPickupRecord[]> {
    const first = Math.min(Math.max(options.first, 1), PICKUP_LIMITS.listed);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<PickupRow>(sql`
        SELECT ${PICKUP_COLUMNS} FROM ${PICKUP_FROM}
         WHERE p.shop_id = ${tenant.shopId}
           ${options.accountId ? sql`AND p.account_id = ${options.accountId}` : sql``}
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ${first}`);
      return rows.map((row) => this.#toRecord(row));
    });
  }

  async get(tenant: TenantContext, id: string): Promise<CourierPickupRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => this.#pickupIn(tx, tenant.shopId, id));
  }

  /** The bookings of the parcels the pickup handed over, the longest waiting first. */
  async bookingsOf(tenant: TenantContext, pickupId: string): Promise<CourierBookingRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<BookingRow>(sql`
        SELECT ${BOOKING_COLUMNS}
          FROM ${BOOKING_FROM}
          JOIN logistics.pickup_parcels pp
            ON pp.shop_id = b.shop_id AND pp.booking_id = b.id AND pp.pickup_id = ${pickupId}
         WHERE b.shop_id = ${tenant.shopId}
         ORDER BY b.booked_at, b.id`);
      return rows.map((row) => bookingRecordOf(row, this.couriers));
    });
  }

  /** A URL that gives the courier's own load sheet for an hour; null where none is kept. */
  documentUrlOf(pickup: CourierPickupRecord): string | null {
    if (!pickup.documentKey || !this.storage) return null;
    const day = (pickup.requestedAt ?? pickup.createdAt).toISOString().slice(0, 10);
    return this.storage.signDownload(pickup.documentKey, SHEET_URL_SECONDS, {
      filename: `${pickup.courier}-load-sheet-${pickup.reference ?? day}.pdf`,
    });
  }

  /** The courier refused the pickup, or could not be asked: its parcels go in the next. */
  async #refused(shopId: string, pickupId: string, message: string): Promise<void> {
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE logistics.pickups SET status = 'failed', error = ${message.slice(0, 1_000)}
         WHERE shop_id = ${shopId} AND id = ${pickupId}`),
    );
  }

  async #pickupIn(tx: Tx, shopId: string, id: string): Promise<CourierPickupRecord | null> {
    const { rows } = await tx.execute<PickupRow>(sql`
      SELECT ${PICKUP_COLUMNS} FROM ${PICKUP_FROM}
       WHERE p.shop_id = ${shopId} AND p.id = ${id}`);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  #toRecord(row: PickupRow): CourierPickupRecord {
    return {
      id: row.id,
      accountId: row.account_id,
      courier: row.courier,
      courierName: this.couriers.of(row.courier)?.info.name ?? row.courier,
      status: row.status,
      parcelCount: row.parcel_count,
      reference: row.reference,
      rider:
        row.rider_name !== null && row.rider_code !== null
          ? { name: row.rider_name, code: row.rider_code }
          : null,
      documentKey: row.document_key,
      error: row.error,
      requestedBy: { kind: row.requested_by_kind, id: row.requested_by_id },
      requestedAt: row.requested_at === null ? null : toDate(row.requested_at),
      createdAt: toDate(row.created_at),
    };
  }
}
