import { failOne, shopProfile, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/** How many months of cohorts a report covers at most, this month the last. */
export const COHORT_LIMITS = { months: 24 } as const;

/**
 * The customers whose first order the shop took in one month, in its time zone (ANL-04,
 * ADR-774), and how many of them ordered again in each month after.
 */
export interface CustomerCohort {
  /** "2026-10". */
  month: string;
  /** Customers whose first order, cancelled ones aside, was placed in the month. */
  customers: number;
  /**
   * How many of them ordered in each month after, the next first, up to this month: a customer
   * counts once in a month however many orders they placed in it.
   */
  returned: number[];
  /** How many of them have placed more than one order, at any time since. */
  orderedAgain: number;
}

interface CohortRow extends Record<string, unknown> {
  cohort: string;
  months_after: number;
  customers: number;
}

interface AgainRow extends Record<string, unknown> {
  cohort: string;
  again: number;
}

/**
 * Customers in cohorts by the month of their first order, and how many came back (ANL-04,
 * ADR-774): retention as a table, a cohort a row and a month after a column. Orders count in the
 * month they were placed in the shop's time zone, cancelled ones aside; worked out from the
 * orders when asked, nothing stored.
 */
@Injectable()
export class CustomerCohortsService {
  constructor(private readonly db: Database) {}

  /** The last `months` cohorts, this month's the last, each with the months after it so far. */
  async cohorts(
    tenant: TenantContext,
    input: { months: number },
  ): Promise<MutationResult<CustomerCohort[]>> {
    const { months } = input;
    if (!Number.isInteger(months) || months < 1 || months > COHORT_LIMITS.months) {
      return failOne(
        ['months'],
        'INVALID',
        `A cohort report covers 1 to ${COHORT_LIMITS.months} months`,
      );
    }
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      const month = (at: ReturnType<typeof sql>) =>
        sql`date_trunc('month', ${at} AT TIME ZONE ${timezone})`;
      const since = sql`(${month(sql`now()`)} - make_interval(months => ${months - 1}))`;
      const { rows: cells } = await tx.execute<CohortRow>(sql`
        WITH firsts AS (
          SELECT customer_id, ${month(sql`min(created_at)`)} AS cohort
            FROM orders.orders
           WHERE shop_id = ${shopId} AND status <> 'cancelled'
           GROUP BY customer_id
        ), active AS (
          SELECT DISTINCT customer_id, ${month(sql`created_at`)} AS month
            FROM orders.orders
           WHERE shop_id = ${shopId} AND status <> 'cancelled'
        )
        SELECT to_char(f.cohort, 'YYYY-MM') AS cohort,
               ((extract(year FROM a.month) - extract(year FROM f.cohort)) * 12
                 + extract(month FROM a.month) - extract(month FROM f.cohort))::int AS months_after,
               count(*)::int AS customers
          FROM firsts f
          JOIN active a ON a.customer_id = f.customer_id AND a.month >= f.cohort
         WHERE f.cohort >= ${since}
         GROUP BY 1, 2`);
      const { rows: again } = await tx.execute<AgainRow>(sql`
        SELECT to_char(cohort, 'YYYY-MM') AS cohort, count(*)::int AS again
          FROM (SELECT ${month(sql`min(created_at)`)} AS cohort, count(*) AS orders
                  FROM orders.orders
                 WHERE shop_id = ${shopId} AND status <> 'cancelled'
                 GROUP BY customer_id) c
         WHERE cohort >= ${since} AND orders > 1
         GROUP BY 1`);
      const { rows: now } = await tx.execute<{ month: string }>(
        sql`SELECT to_char(${month(sql`now()`)}, 'YYYY-MM') AS month`,
      );
      return { ok: true, value: cohortsOf(now[0]!.month, months, cells, again) };
    });
  }
}

/** Every month of the last `months` up to `current` ("YYYY-MM"), with what the rows counted. */
function cohortsOf(
  current: string,
  months: number,
  cells: readonly CohortRow[],
  again: readonly AgainRow[],
): CustomerCohort[] {
  const [year, month] = current.split('-').map(Number) as [number, number];
  const cohorts: CustomerCohort[] = [];
  for (let back = months - 1; back >= 0; back--) {
    const at = new Date(Date.UTC(year, month - 1 - back, 1));
    const key = at.toISOString().slice(0, 7);
    const counts = new Map(
      cells
        .filter((cell) => cell.cohort === key)
        .map((cell) => [cell.months_after, cell.customers]),
    );
    cohorts.push({
      month: key,
      customers: counts.get(0) ?? 0,
      returned: Array.from({ length: back }, (_, index) => counts.get(index + 1) ?? 0),
      orderedAgain: again.find((row) => row.cohort === key)?.again ?? 0,
    });
  }
  return cohorts;
}
