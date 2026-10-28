import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { SEGMENT_TIME_ZONE } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { customerFactsQuery } from './customer-facts.js';

// Customers by how recently and how often they buy (ANL-04, ADR-887): RFM, as Shopify's customer
// analytics groups them, on a grid of three by three. How recently is by the days since their
// last order, against the two lines the shop draws; how often is by their delivered orders, as a
// Pakistani shop counts a sale: one, two or three, four or more. What they spent is beside each.
// Each group is a segment's query over the same facts (ADR-023), so a shop can save it as one and
// send it a campaign; the counts here are the segment's.

export const RFM_LIMITS = {
  /** The most days the lines may be drawn at: two years. */
  days: 730,
} as const;

export const RFM_RECENCIES = ['recent', 'slipping', 'lapsed'] as const;
export type RfmRecency = (typeof RFM_RECENCIES)[number];
export const RFM_FREQUENCIES = ['once', 'few', 'many'] as const;
export type RfmFrequency = (typeof RFM_FREQUENCIES)[number];

/** Each cell's name, as merchants know RFM's groups. */
export const RFM_GROUPS = {
  recent: { many: 'champions', few: 'potential_loyalists', once: 'new_customers' },
  slipping: { many: 'loyal', few: 'needs_attention', once: 'about_to_sleep' },
  lapsed: { many: 'cant_lose', few: 'at_risk', once: 'lost' },
} as const satisfies Record<RfmRecency, Record<RfmFrequency, string>>;
export type RfmGroupName = (typeof RFM_GROUPS)[RfmRecency][RfmFrequency];

export interface RfmGroup {
  name: RfmGroupName;
  recency: RfmRecency;
  frequency: RfmFrequency;
  customers: number;
  /** What they spent together, in minor units: paid on orders not cancelled, less refunds. */
  amountSpent: bigint;
  /** Their delivered orders on average; null without customers. */
  averageOrders: number | null;
  /** The segment query that finds them: "delivered_orders >= 4 AND last_order_date > -30d". */
  query: string;
}

export interface RfmReport {
  recentDays: number;
  lapsedDays: number;
  /** Customers who have ordered, in a group each. */
  customers: number;
  /** Recent first, the most orders first in each. */
  groups: RfmGroup[];
}

/** The segment query of a cell, as the grid's lines draw it. */
export function rfmQuery(
  recency: RfmRecency,
  frequency: RfmFrequency,
  recentDays: number,
  lapsedDays: number,
): string {
  const often = {
    once: 'delivered_orders <= 1',
    few: 'delivered_orders BETWEEN 2 AND 3',
    many: 'delivered_orders >= 4',
  }[frequency];
  const recently = {
    recent: `last_order_date > -${recentDays}d`,
    slipping: `last_order_date <= -${recentDays}d AND last_order_date > -${lapsedDays}d`,
    lapsed: `last_order_date <= -${lapsedDays}d`,
  }[recency];
  return `${often} AND ${recently}`;
}

interface CellRow extends Record<string, unknown> {
  recency: RfmRecency;
  frequency: RfmFrequency;
  customers: number;
  spent: string;
  orders: number;
}

@Injectable()
export class CustomerRfmService {
  constructor(private readonly db: Database) {}

  /**
   * The shop's customers who have ordered, on the grid: recent where they last ordered within
   * `recentDays`, lapsed where `lapsedDays` ago or more, slipping between; by their delivered
   * orders, one or none, two or three, four or more. Worked out when asked, nothing stored.
   */
  async report(
    tenant: TenantContext,
    input: { recentDays: number; lapsedDays: number },
  ): Promise<MutationResult<RfmReport>> {
    const { recentDays, lapsedDays } = input;
    for (const [field, days] of [
      ['recentDays', recentDays],
      ['lapsedDays', lapsedDays],
    ] as const) {
      if (!Number.isInteger(days) || days < 1 || days > RFM_LIMITS.days) {
        return failOne([field], 'INVALID', `Days are 1 to ${RFM_LIMITS.days}`);
      }
    }
    if (lapsedDays <= recentDays) {
      return failOne(['lapsedDays'], 'INVALID', 'Lapsed must be longer ago than recent');
    }
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      // As segments read dates (ADR-023): days in Pakistan's time, "-30d" 30 days before today.
      const today = sql`(now() AT TIME ZONE ${SEGMENT_TIME_ZONE})::date`;
      const lastDay = sql`(f.last_order_at AT TIME ZONE ${SEGMENT_TIME_ZONE})::date`;
      const { rows } = await tx.execute<CellRow>(sql`
        WITH cells AS (
          SELECT CASE WHEN ${lastDay} > ${today} - ${recentDays}::int THEN 'recent'
                      WHEN ${lastDay} > ${today} - ${lapsedDays}::int THEN 'slipping'
                      ELSE 'lapsed' END AS recency,
                 CASE WHEN f.delivered_orders <= 1 THEN 'once'
                      WHEN f.delivered_orders <= 3 THEN 'few'
                      ELSE 'many' END AS frequency,
                 f.amount_spent, f.delivered_orders
            FROM (${customerFactsQuery(shopId)}) f
           WHERE f.customer_id IS NOT NULL AND f.last_order_at IS NOT NULL
        )
        SELECT recency, frequency, count(*)::int AS customers,
               coalesce(sum(amount_spent), 0)::text AS spent,
               coalesce(sum(delivered_orders), 0)::int AS orders
          FROM cells
         GROUP BY recency, frequency`);
      const groups: RfmGroup[] = [];
      for (const recency of RFM_RECENCIES) {
        for (const frequency of [...RFM_FREQUENCIES].reverse()) {
          const row = rows.find((each) => each.recency === recency && each.frequency === frequency);
          const customers = row?.customers ?? 0;
          groups.push({
            name: RFM_GROUPS[recency][frequency],
            recency,
            frequency,
            customers,
            amountSpent: BigInt(row?.spent ?? 0),
            averageOrders: customers ? Math.round((row!.orders / customers) * 10) / 10 : null,
            query: rfmQuery(recency, frequency, recentDays, lapsedDays),
          });
        }
      }
      return {
        ok: true,
        value: {
          recentDays,
          lapsedDays,
          customers: groups.reduce((sum, group) => sum + group.customers, 0),
          groups,
        },
      };
    });
  }
}
