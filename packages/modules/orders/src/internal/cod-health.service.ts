import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { OrderSourceValue } from './schema.js';

export const COD_HEALTH_LIMITS = {
  /** The longest period asked for at once. */
  days: 366,
} as const;

/** What COD health is broken down by. */
export const COD_HEALTH_DIMENSIONS = ['city', 'product', 'source', 'courier'] as const;
export type CodHealthDimension = (typeof COD_HEALTH_DIMENSIONS)[number];

export interface CodHealthInput {
  /** Orders placed at or after this… */
  placedFrom: Date;
  /** …and before this. */
  placedBefore: Date;
  by?: CodHealthDimension | null;
  /** Rows at most, most orders first. */
  first: number;
}

/** How a period's cash-on-delivery orders went at confirmation. */
export interface CodConfirmationTally {
  placed: number;
  /** By the customer or staff, whatever came after. */
  confirmed: number;
  /** Cancelled before anyone confirmed them: declined, unreachable, fake or out of stock. */
  cancelled: number;
  /** Still to be confirmed or reviewed. */
  awaiting: number;
}

/** How their parcels went. */
export interface CodDeliveryTally {
  shipped: number;
  delivered: number;
  /** Refused or undeliverable: on their way back, or back. */
  returned: number;
  inTransit: number;
}

export interface CodHealthRow {
  /**
   * The city as orders keep it, the product's ID, the source, or the courier as staff named it;
   * null for parcels shipped without a courier named.
   */
  key: string | null;
  title: string;
  /** Null by courier: a courier is chosen after an order is confirmed. */
  confirmation: CodConfirmationTally | null;
  delivery: CodDeliveryTally;
}

export interface CodHealthReport {
  confirmation: CodConfirmationTally;
  delivery: CodDeliveryTally;
  /** By what `by` names, most orders first; none without it. */
  rows: CodHealthRow[];
}

const SOURCE_TITLES: Readonly<Record<OrderSourceValue, string>> = {
  online_store: 'Online store',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  pos: 'Point of sale',
  manual: 'Entered by staff',
  api: 'Apps',
  marketplace: 'Marketplaces',
  reseller: 'Resellers',
};

const NO_COURIER = 'No courier named';

/** Orders counted once each, whatever a join repeats them for. */
const CONFIRMATION = sql`
  count(DISTINCT o.id)::int AS placed,
  count(DISTINCT o.id) FILTER (WHERE o.confirmed_at IS NOT NULL)::int AS confirmed,
  count(DISTINCT o.id) FILTER (WHERE o.confirmed_at IS NULL AND o.status = 'cancelled')::int
    AS cancelled`;

/** Parcels counted once each. */
const DELIVERY = sql`
  count(DISTINCT f.id)::int AS shipped,
  count(DISTINCT f.id) FILTER (WHERE f.status = 'delivered')::int AS delivered,
  count(DISTINCT f.id) FILTER (WHERE f.status IN ('returning', 'returned'))::int AS returned`;

const PARCELS = sql`JOIN orders.fulfillments f ON f.shop_id = o.shop_id AND f.order_id = o.id`;

// Types rather than interfaces: rows of `execute` must be records.
type ConfirmationRow = {
  key: string | null;
  title?: string | null;
  placed: number;
  confirmed: number;
  cancelled: number;
};

type DeliveryRow = {
  key: string | null;
  title?: string | null;
  shipped: number;
  delivered: number;
  returned: number;
};

/** How a dimension groups orders and parcels, and names its rows. */
interface Grouping {
  confirmation: ((cohort: SQL) => SQL) | null;
  delivery: (cohort: SQL) => SQL;
}

const GROUPINGS: Readonly<Record<CodHealthDimension, Grouping>> = {
  // Cities typed differently in letter case are one; the row takes the spelling most used.
  city: {
    confirmation: (cohort) => sql`
      SELECT lower(o.shipping_address->>'city') AS key,
             mode() WITHIN GROUP (ORDER BY o.shipping_address->>'city') AS title, ${CONFIRMATION}
        FROM orders.orders o WHERE ${cohort} GROUP BY 1`,
    delivery: (cohort) => sql`
      SELECT lower(o.shipping_address->>'city') AS key, ${DELIVERY}
        FROM orders.orders o ${PARCELS} WHERE ${cohort} GROUP BY 1`,
  },
  // An order counts once for each product in it, and a parcel for each product it carried; a
  // product goes by the title it was last sold under.
  product: {
    confirmation: (cohort) => sql`
      SELECT l.product_id::text AS key,
             (array_agg(l.title ORDER BY o.created_at DESC, o.id DESC))[1] AS title,
             ${CONFIRMATION}
        FROM orders.orders o
        JOIN orders.lines l ON l.shop_id = o.shop_id AND l.order_id = o.id
       WHERE ${cohort} GROUP BY 1`,
    delivery: (cohort) => sql`
      SELECT l.product_id::text AS key, ${DELIVERY}
        FROM orders.orders o ${PARCELS}
        JOIN orders.fulfillment_lines fl ON fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id
        JOIN orders.lines l ON l.shop_id = fl.shop_id AND l.id = fl.line_id
       WHERE ${cohort} GROUP BY 1`,
  },
  source: {
    confirmation: (cohort) => sql`
      SELECT o.source AS key, ${CONFIRMATION} FROM orders.orders o WHERE ${cohort} GROUP BY 1`,
    delivery: (cohort) => sql`
      SELECT o.source AS key, ${DELIVERY}
        FROM orders.orders o ${PARCELS} WHERE ${cohort} GROUP BY 1`,
  },
  // Couriers as staff named them when shipping, in any letter case.
  courier: {
    confirmation: null,
    delivery: (cohort) => sql`
      SELECT lower(btrim(f.tracking_company)) AS key,
             mode() WITHIN GROUP (ORDER BY btrim(f.tracking_company)) AS title, ${DELIVERY}
        FROM orders.orders o ${PARCELS} WHERE ${cohort} GROUP BY 1`,
  },
};

/**
 * COD health (COD-12): how a period's cash-on-delivery orders turned out, as
 * docs/architecture/06-orders-fulfillment-logistics.md §11 measures it: confirmed of those
 * placed, and delivered and returned of the parcels shipped, for the shop and by city, product,
 * source or courier. Worked out from the orders and their parcels when asked, as the stage counts
 * are; nothing is stored.
 */
@Injectable()
export class CodHealthService {
  constructor(private readonly db: Database) {}

  async report(
    tenant: TenantContext,
    input: CodHealthInput,
  ): Promise<MutationResult<CodHealthReport>> {
    const span = input.placedBefore.getTime() - input.placedFrom.getTime();
    if (span <= 0) {
      return failOne(['placedBefore'], 'INVALID', 'Placed before must be later than placed from');
    }
    if (span > COD_HEALTH_LIMITS.days * 86_400_000) {
      return failOne(
        ['placedBefore'],
        'INVALID',
        `COD health covers at most ${COD_HEALTH_LIMITS.days} days at a time`,
      );
    }
    const cohort = sql`o.shop_id = ${tenant.shopId}
      AND o.payment_method = 'cash_on_delivery'
      AND o.created_at >= ${input.placedFrom} AND o.created_at < ${input.placedBefore}`;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [overallConfirmation] = (
        await tx.execute<ConfirmationRow>(sql`
          SELECT NULL AS key, ${CONFIRMATION} FROM orders.orders o WHERE ${cohort}`)
      ).rows;
      const [overallDelivery] = (
        await tx.execute<DeliveryRow>(sql`
          SELECT NULL AS key, ${DELIVERY} FROM orders.orders o ${PARCELS} WHERE ${cohort}`)
      ).rows;
      const report: CodHealthReport = {
        confirmation: confirmationOf(overallConfirmation),
        delivery: deliveryOf(overallDelivery),
        rows: [],
      };
      if (!input.by) return { ok: true, value: report };

      const grouping = GROUPINGS[input.by];
      const confirmations = grouping.confirmation
        ? (await tx.execute<ConfirmationRow>(grouping.confirmation(cohort))).rows
        : [];
      const deliveries = (await tx.execute<DeliveryRow>(grouping.delivery(cohort))).rows;
      report.rows = rowsOf(input.by, confirmations, deliveries)
        .sort(byVolume)
        .slice(0, input.first);
      return { ok: true, value: report };
    });
  }
}

function confirmationOf(row: ConfirmationRow | undefined): CodConfirmationTally {
  const placed = row?.placed ?? 0;
  const confirmed = row?.confirmed ?? 0;
  const cancelled = row?.cancelled ?? 0;
  return { placed, confirmed, cancelled, awaiting: placed - confirmed - cancelled };
}

function deliveryOf(row: DeliveryRow | undefined): CodDeliveryTally {
  const shipped = row?.shipped ?? 0;
  const delivered = row?.delivered ?? 0;
  const returned = row?.returned ?? 0;
  return { shipped, delivered, returned, inTransit: shipped - delivered - returned };
}

/** Each group's rows of orders and of parcels as one, keyed and titled as the dimension says. */
function rowsOf(
  by: CodHealthDimension,
  confirmations: ConfirmationRow[],
  deliveries: DeliveryRow[],
): CodHealthRow[] {
  const parcels = new Map(deliveries.map((row) => [row.key, row]));
  const named = (row: ConfirmationRow | DeliveryRow): Pick<CodHealthRow, 'key' | 'title'> => {
    switch (by) {
      case 'city':
        return { key: row.title ?? '', title: row.title ?? '' };
      case 'product':
        return { key: row.key, title: row.title ?? '' };
      case 'source': {
        const source = row.key as OrderSourceValue;
        return { key: source, title: SOURCE_TITLES[source] };
      }
      case 'courier':
        return row.key === null
          ? { key: null, title: NO_COURIER }
          : { key: row.title ?? row.key, title: row.title ?? row.key };
    }
  };
  if (GROUPINGS[by].confirmation === null) {
    return deliveries.map((row) => ({
      ...named(row),
      confirmation: null,
      delivery: deliveryOf(row),
    }));
  }
  // Every group with parcels has orders, so the orders' groups are all there are.
  return confirmations.map((row) => ({
    ...named(row),
    confirmation: confirmationOf(row),
    delivery: deliveryOf(parcels.get(row.key)),
  }));
}

/** Most orders first, then most parcels, then by title. */
function byVolume(a: CodHealthRow, b: CodHealthRow): number {
  return (
    (b.confirmation?.placed ?? 0) - (a.confirmation?.placed ?? 0) ||
    b.delivery.shipped - a.delivery.shipped ||
    a.title.localeCompare(b.title)
  );
}
