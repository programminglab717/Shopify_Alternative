import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  actorColumnsOf,
  failOne,
  shopProfile,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { FulfillmentService, orderShipmentFactsIn } from '@hatti/orders/public';
import { parsePkMobile } from '@hatti/pk';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// The shop's own riders (SHP-10, ADR-824): each with a page of their own, opened from a link
// that carries a secret, with no account. A packed order handed to a rider is shipped with them
// as its courier, and its customer is sent a code on WhatsApp to give the rider at the door, kept
// only as its digest. The cash each rider collected is what they owe the shop until handed over.

export const RIDER_LIMITS = {
  perShop: 50,
  name: 80,
  /** Orders handed to a rider at once. */
  handOut: 50,
  /** Tries at a delivery's code, so that it is not guessed. */
  codeTries: 5,
  reason: 300,
  note: 500,
} as const;

/** Events of the shop's riders. */
export const RiderEvents = {
  /** A delivery was made or failed, as its rider said. */
  DeliveryUpdated: 'rider_delivery.updated',
} as const;

/**
 * Sends a delivery's code to its customer, in the caller's transaction, as the host application
 * can: on WhatsApp, as messages are sent. Without it, as in tests, none is sent.
 */
export abstract class DeliveryCodeSender {
  abstract sendIn(
    tx: Tx,
    shopId: string,
    message: {
      phone: string;
      orderId: string;
      /** The parcel it goes with: a code a parcel. */
      parcelId: string;
      order: string;
      rider: string;
      code: string;
    },
  ): Promise<boolean>;
}

export interface RiderRecord {
  id: string;
  name: string;
  phone: string;
  active: boolean;
  /** Deliveries they carry now. */
  out: number;
  /** Minor units: what they collected and have not handed over. */
  cashHeld: bigint;
  createdAt: Date;
}

export interface RiderInput {
  name: string;
  /** A Pakistani mobile, as typed. */
  phone: string;
  active?: boolean;
}

export type DeliveryStatus = 'out' | 'delivered' | 'failed';

export interface DeliveryRecord {
  id: string;
  riderId: string;
  orderId: string;
  fulfillmentId: string;
  status: DeliveryStatus;
  cashDue: bigint;
  cashCollected: bigint;
  /** Whether a code was sent to its customer, and whether the rider gave it. */
  codeSent: boolean;
  codeGiven: boolean;
  failedReason: string | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
}

/** What handing an order to a rider came to: its delivery, or why not. */
export type HandOutResult =
  { orderId: string; delivery: DeliveryRecord } | { orderId: string; problem: string };

const digest = (text: string) => createHash('sha256').update(text).digest();

/** Where riders' pages are served: /r/<secret>. */
export const RIDER_LINK_PATH = 'r';

/** A rider's page's secret: 128 random bits, as customers' links have. */
export const RIDER_LINK = /^[A-Za-z0-9_-]{22}$/;

type RiderRow = {
  id: string;
  name: string;
  phone: string;
  active: boolean;
  out: number;
  cash_held: string;
  created_at: string | Date;
};

const RIDER_COLUMNS = sql`
  r.id, r.name, r.phone, r.active, r.created_at,
  (SELECT count(*)::int FROM logistics.rider_deliveries d
    WHERE d.shop_id = r.shop_id AND d.rider_id = r.id AND d.status = 'out') AS out,
  ((SELECT coalesce(sum(d.cash_collected), 0) FROM logistics.rider_deliveries d
     WHERE d.shop_id = r.shop_id AND d.rider_id = r.id)
   - (SELECT coalesce(sum(h.amount), 0) FROM logistics.rider_handovers h
       WHERE h.shop_id = r.shop_id AND h.rider_id = r.id))::text AS cash_held`;

const toRider = (row: RiderRow): RiderRecord => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  active: row.active,
  out: row.out,
  cashHeld: BigInt(row.cash_held),
  createdAt: new Date(row.created_at),
});

type DeliveryRow = {
  id: string;
  rider_id: string;
  order_id: string;
  fulfillment_id: string;
  status: DeliveryStatus;
  cash_due: string;
  cash_collected: string;
  code_sent: boolean;
  code_given: boolean;
  failed_reason: string | null;
  delivered_at: string | Date | null;
  failed_at: string | Date | null;
  created_at: string | Date;
};

export const DELIVERY_COLUMNS = sql`
  d.id, d.rider_id, d.order_id, d.fulfillment_id, d.status, d.cash_due::text AS cash_due,
  d.cash_collected::text AS cash_collected, d.code_hash IS NOT NULL AS code_sent, d.code_given,
  d.failed_reason, d.delivered_at, d.failed_at, d.created_at`;

export const toDelivery = (row: DeliveryRow): DeliveryRecord => ({
  id: row.id,
  riderId: row.rider_id,
  orderId: row.order_id,
  fulfillmentId: row.fulfillment_id,
  status: row.status,
  cashDue: BigInt(row.cash_due),
  cashCollected: BigInt(row.cash_collected),
  codeSent: row.code_sent,
  codeGiven: row.code_given,
  failedReason: row.failed_reason,
  deliveredAt: row.delivered_at === null ? null : new Date(row.delivered_at),
  failedAt: row.failed_at === null ? null : new Date(row.failed_at),
  createdAt: new Date(row.created_at),
});

/** What is wrong with a rider as given, if anything. */
function checkedRider(input: RiderInput): MutationResult<{ name: string; phone: string }> {
  const errors: FieldError[] = [];
  const name = input.name.trim();
  if (name.length < 1 || name.length > RIDER_LIMITS.name) {
    errors.push({
      field: ['input', 'name'],
      code: 'INVALID',
      message: `Give the rider's name, up to ${RIDER_LIMITS.name} characters`,
    });
  }
  const phone = parsePkMobile(input.phone)?.e164 ?? null;
  if (!phone) {
    errors.push({
      field: ['input', 'phone'],
      code: 'INVALID',
      message: 'Give a Pakistani mobile number, such as 0300 1234567',
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { name, phone: phone! } };
}

/**
 * The shop's riders and the deliveries it hands them (ADR-824): riders added, changed and given a
 * new link; packed orders handed to one, each shipped with them and its customer sent a code.
 */
@Injectable()
export class RiderService {
  constructor(
    private readonly db: Database,
    private readonly fulfillments: FulfillmentService,
    @Optional()
    @Inject(DeliveryCodeSender)
    private readonly codes: DeliveryCodeSender | null = null,
  ) {}

  /** The shop's riders, by name, the inactive last. */
  async list(tenant: TenantContext): Promise<RiderRecord[]> {
    const { shopId } = tenant;
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<RiderRow>(sql`
        SELECT ${RIDER_COLUMNS} FROM logistics.riders r
         WHERE r.shop_id = ${shopId}
         ORDER BY r.active DESC, lower(r.name), r.id`),
    );
    return rows.map(toRider);
  }

  async get(tenant: TenantContext, id: string): Promise<RiderRecord | null> {
    const { shopId } = tenant;
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<RiderRow>(sql`
        SELECT ${RIDER_COLUMNS} FROM logistics.riders r
         WHERE r.shop_id = ${shopId} AND r.id = ${id}`),
    );
    return rows[0] ? toRider(rows[0]) : null;
  }

  /** Adds a rider: theirs, and the secret of their page's link, given this once. */
  async create(
    tenant: TenantContext,
    input: RiderInput,
  ): Promise<MutationResult<{ rider: RiderRecord; link: string }>> {
    const given = checkedRider(input);
    if (!given.ok) return given;
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('riders:' || ${shopId}))`);
      const { rows: counted } = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM logistics.riders WHERE shop_id = ${shopId}`);
      if (counted[0]!.n >= RIDER_LIMITS.perShop) {
        return failOne(
          ['input'],
          'TOO_MANY',
          `A shop keeps ${RIDER_LIMITS.perShop} riders at most: make one inactive and change them`,
        );
      }
      const link = randomBytes(16).toString('base64url');
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO logistics.riders (shop_id, name, phone, link_hash)
        VALUES (${shopId}, ${given.value.name}, ${given.value.phone}, ${digest(link)})
        RETURNING id`);
      const id = rows[0]!.id;
      await recordAudit(tx, shopId, {
        action: 'rider.created',
        subjectType: 'rider',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: { name: given.value.name },
      });
      const { rows: made } = await tx.execute<RiderRow>(sql`
        SELECT ${RIDER_COLUMNS} FROM logistics.riders r WHERE r.shop_id = ${shopId} AND r.id = ${id}`);
      return { ok: true, value: { rider: toRider(made[0]!), link } };
    });
  }

  /** Changes a rider's name, number, or whether they ride for the shop now. */
  async update(
    tenant: TenantContext,
    id: string,
    input: RiderInput,
  ): Promise<MutationResult<RiderRecord>> {
    const given = checkedRider(input);
    if (!given.ok) return given;
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE logistics.riders
           SET name = ${given.value.name}, phone = ${given.value.phone},
               active = ${input.active ?? true}, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id}
        RETURNING id`);
      if (!rows[0]) return failOne(['id'], 'NOT_FOUND', 'Rider not found');
      await recordAudit(tx, shopId, {
        action: 'rider.updated',
        subjectType: 'rider',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: { name: given.value.name, active: input.active ?? true },
      });
      const { rows: changed } = await tx.execute<RiderRow>(sql`
        SELECT ${RIDER_COLUMNS} FROM logistics.riders r WHERE r.shop_id = ${shopId} AND r.id = ${id}`);
      return { ok: true, value: toRider(changed[0]!) };
    });
  }

  /** A new link for a rider's page, the old one working no more: its secret, given this once. */
  async newLink(tenant: TenantContext, id: string): Promise<MutationResult<string>> {
    const { shopId } = tenant;
    const link = randomBytes(16).toString('base64url');
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute(sql`
        UPDATE logistics.riders SET link_hash = ${digest(link)}, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id}
        RETURNING id`);
      if (rows.length === 0) return failOne(['id'], 'NOT_FOUND', 'Rider not found');
      await recordAudit(tx, shopId, {
        action: 'rider.link_changed',
        subjectType: 'rider',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
      });
      return { ok: true, value: link };
    });
  }

  /**
   * Hands packed orders to rider `riderId`, each in a transaction of its own: shipped with them,
   * everything left to ship in one parcel, its cash on delivery the rider's to collect, and its
   * customer sent a code to give the rider at the door, where a number and a sender allow. One
   * refused stops none of the others.
   */
  async handOut(
    tenant: TenantContext,
    riderId: string,
    orderIds: readonly string[],
  ): Promise<MutationResult<HandOutResult[]>> {
    const ids = [...new Set(orderIds)];
    if (ids.length === 0 || ids.length > RIDER_LIMITS.handOut) {
      return failOne(
        ['orderIds'],
        ids.length === 0 ? 'BLANK' : 'TOO_MANY',
        `Hand out 1 to ${RIDER_LIMITS.handOut} orders at a time`,
      );
    }
    const rider = await this.get(tenant, riderId);
    if (!rider) return failOne(['riderId'], 'NOT_FOUND', 'Rider not found');
    if (!rider.active) {
      return failOne(['riderId'], 'INVALID', `${rider.name} does not ride for the shop now`);
    }
    const results: HandOutResult[] = [];
    for (const orderId of ids) {
      results.push(await this.#handOne(tenant, rider, orderId));
    }
    return { ok: true, value: results };
  }

  async #handOne(
    tenant: TenantContext,
    rider: RiderRecord,
    orderId: string,
  ): Promise<HandOutResult> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx): Promise<HandOutResult> => {
      const facts = await orderShipmentFactsIn(tx, shopId, orderId);
      if (!facts) return { orderId, problem: 'Order not found' };
      const { name: shop } = await shopProfile(tx, shopId);
      const shipped = await this.fulfillments.fulfillIn(tx, tenant, orderId, {
        tracking: {
          company: `${shop}'s rider ${rider.name}`.slice(0, 100),
          number: `R-${randomBytes(5).toString('hex').toUpperCase()}`,
        },
      });
      if (!shipped.ok) return { orderId, problem: shipped.errors[0]!.message };
      const code = String(randomInt(0, 10_000)).padStart(4, '0');
      const phone = facts.address?.phone ?? null;
      const sent =
        phone !== null &&
        this.codes !== null &&
        (await this.codes.sendIn(tx, shopId, {
          phone,
          orderId,
          parcelId: shipped.value.fulfillmentId,
          order: facts.name,
          rider: rider.name,
          code,
        }));
      const { rows } = await tx.execute<DeliveryRow>(sql`
        INSERT INTO logistics.rider_deliveries AS d
               (shop_id, rider_id, order_id, fulfillment_id, cash_due, code_hash)
        VALUES (${shopId}, ${rider.id}, ${orderId}, ${shipped.value.fulfillmentId},
                ${facts.codAmount.toString()}::bigint, ${sent ? digest(code) : null})
        RETURNING ${DELIVERY_COLUMNS}`);
      await appendEvent(tx, shopId, {
        type: RiderEvents.DeliveryUpdated,
        aggregateType: 'rider_delivery',
        aggregateId: rows[0]!.id,
        payload: { status: 'out', riderId: rider.id, orderId },
      });
      return { orderId, delivery: toDelivery(rows[0]!) };
    });
  }

  /** The deliveries of rider `riderId`, or all the shop's, the latest first: 100 at most. */
  async deliveries(
    tenant: TenantContext,
    filter: { riderId?: string | null; status?: DeliveryStatus | null } = {},
  ): Promise<DeliveryRecord[]> {
    const { shopId } = tenant;
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<DeliveryRow>(sql`
        SELECT ${DELIVERY_COLUMNS} FROM logistics.rider_deliveries d
         WHERE d.shop_id = ${shopId}
           AND (${filter.riderId ?? null}::uuid IS NULL OR d.rider_id = ${filter.riderId ?? null})
           AND (${filter.status ?? null}::text IS NULL OR d.status = ${filter.status ?? null})
         ORDER BY d.created_at DESC, d.id
         LIMIT 100`),
    );
    return rows.map(toDelivery);
  }
}
