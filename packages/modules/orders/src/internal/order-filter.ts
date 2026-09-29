import { parsePkMobile, searchKey } from '@hatti/pk';
import { sql, type SQL } from 'drizzle-orm';
import type { OrderStageValue, RiskLevelValue } from './schema.js';

/** Which orders a list or an export covers. Every part left out matches all. */
export interface OrderFilter {
  /**
   * An order number ("1001" or "#1001"), a mobile number in any format, a parcel's tracking
   * number, or words of the customer's name, city or email.
   */
  query?: string | null;
  stage?: OrderStageValue | null;
  riskLevel?: RiskLevelValue | null;
  /** One customer's orders only. */
  customerId?: string | null;
  /** Placed at or after. */
  placedFrom?: Date | null;
  /** Placed before. */
  placedBefore?: Date | null;
}

/** The filter as SQL conditions on orders `o`, all of which must hold. */
export function orderConditions(filter: OrderFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.stage) conditions.push(sql`o.stage = ${filter.stage}`);
  if (filter.riskLevel) conditions.push(sql`o.risk_level = ${filter.riskLevel}`);
  if (filter.customerId) conditions.push(sql`o.customer_id = ${filter.customerId}`);
  if (filter.placedFrom) conditions.push(sql`o.created_at >= ${filter.placedFrom}`);
  if (filter.placedBefore) conditions.push(sql`o.created_at < ${filter.placedBefore}`);
  const query = filter.query?.trim() ?? '';
  if (query !== '') {
    const mobile = parsePkMobile(query);
    // Every word must appear. Tokens hold only letters and digits, so no LIKE escaping.
    const words = searchKey(query)
      .split(' ')
      .filter(Boolean)
      .map((token) => sql`o.search_text LIKE ${`%${token}%`}`);
    const match = mobile
      ? sql`o.phone = ${mobile.e164}`
      : /^#?\d{1,9}$/.test(query)
        ? sql`o.number = ${Number(query.replace('#', ''))}`
        : words.length > 0
          ? sql.join(words, sql` AND `)
          : sql`false`;
    // A parcel's tracking number finds its order too.
    conditions.push(sql`(${match} OR EXISTS (
      SELECT 1 FROM orders.fulfillments f
       WHERE f.shop_id = o.shop_id AND f.order_id = o.id AND f.tracking_number = ${query}))`);
  }
  return conditions;
}
