import { toDateOrNull, type Tx } from '@hatti/db';
import type { CurrencyCode } from '@hatti/money';
import { sql } from 'drizzle-orm';
import { customerFactsQuery } from './customer-facts.js';
import {
  RECENT_ORDER_HOURS,
  assessRisk,
  defaultRiskSettings,
  type RiskAssessment,
  type RiskSettings,
} from './risk.js';
import type { AddressValue } from './schema.js';

/** A shop's risk policy as stored; `updatedAt` is null while the shop has the defaults. */
export interface RiskSettingsRecord extends RiskSettings {
  updatedAt: Date | null;
}

/** The shop's risk policy, or the defaults if it has not set one. */
export async function loadRiskSettings(
  tx: Tx,
  shopId: string,
  currency: CurrencyCode,
): Promise<RiskSettingsRecord> {
  const { rows } = await tx.execute<{
    hold_at: number | null;
    high_value: string;
    updated_at: string;
  }>(sql`
    SELECT hold_at, high_value::text AS high_value, updated_at
      FROM orders.risk_settings
     WHERE shop_id = ${shopId}`);
  const row = rows[0];
  if (!row) return { ...defaultRiskSettings(currency), updatedAt: null };
  return {
    holdAt: row.hold_at,
    highValue: BigInt(row.high_value),
    updatedAt: toDateOrNull(row.updated_at),
  };
}

/** A cash-on-delivery order, placed or about to be. */
export interface OrderRiskInputs {
  /** Its own row, if it exists yet, is not counted in its customer's history. */
  orderId: string;
  customerId: string;
  total: bigint;
  currency: CurrencyCode;
  units: number;
  address: AddressValue;
}

/**
 * Scores an order against the shop's policy: the customer's other orders as their delivery
 * history counts them, another unshipped order from them in the last hours, and the order itself.
 * One statement; it reads and locks nothing another order's transaction would wait on.
 */
export async function assessOrderRisk(
  tx: Tx,
  shopId: string,
  inputs: OrderRiskInputs,
): Promise<{ assessment: RiskAssessment; settings: RiskSettings }> {
  const settings = await loadRiskSettings(tx, shopId, inputs.currency);
  const { rows } = await tx.execute<{
    number_of_orders: number | null;
    delivered_orders: number | null;
    returned_orders: number | null;
    cancelled_orders: number | null;
    recent_order_number: number | null;
  }>(sql`
    SELECT facts.number_of_orders, facts.delivered_orders, facts.returned_orders,
           facts.cancelled_orders,
           (SELECT o.number FROM orders.orders o
             WHERE o.shop_id = ${shopId} AND o.customer_id = ${inputs.customerId}
               AND o.id <> ${inputs.orderId}
               AND o.status = 'open' AND o.fulfillment_status = 'unfulfilled'
               AND o.created_at > now() - make_interval(hours => ${RECENT_ORDER_HOURS})
             ORDER BY o.id DESC
             LIMIT 1) AS recent_order_number
      FROM (SELECT 1) AS one
      LEFT JOIN (${customerFactsQuery(shopId, [inputs.customerId], {
        exceptOrderId: inputs.orderId,
      })}) AS facts ON true`);
  const row = rows[0]!;
  const assessment = assessRisk({
    total: inputs.total,
    currency: inputs.currency,
    units: inputs.units,
    address: inputs.address,
    history: {
      orders: row.number_of_orders ?? 0,
      delivered: row.delivered_orders ?? 0,
      returned: row.returned_orders ?? 0,
      cancelled: row.cancelled_orders ?? 0,
    },
    recentOrderNumber: row.recent_order_number,
    highValue: settings.highValue,
  });
  return { assessment, settings };
}
