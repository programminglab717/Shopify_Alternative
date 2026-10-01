import { SegmentFieldRegistry, type SegmentFactSource } from '@hatti/customers/public';
import { findCity, findProvince } from '@hatti/pk';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

/** Whether a parcel of order `o` was refused or undeliverable before anything else became of it. */
const REFUSED = sql`EXISTS (SELECT 1 FROM orders.fulfillments f
                             WHERE f.shop_id = o.shop_id AND f.order_id = o.id
                               AND f.returning_at IS NOT NULL)`;

/**
 * What each customer's orders add up to, one row per customer with orders: the single definition
 * behind a customer's stats (ADR-023), the order fields of segments and the history risk rules
 * look at. Only `customerIds`, if given; otherwise every customer of the shop. `exceptOrderId`
 * leaves one order out, such as the one being scored.
 *
 * Amounts are minor units. Cancelled orders count as orders, but what was paid on them does not
 * count as spent, and nor does what was refunded on any order; an order merged into another does
 * not count at all, the customer having placed one order, not two (ADR-132). An order refused at the door counts
 * as returned from when it starts coming back, though its courier then lost it on its way back; an
 * order lost before it reached them counts as lost, which is the courier's doing, not theirs.
 * Where a customer is is where their latest order went.
 */
export function customerFactsQuery(
  shopId: string,
  customerIds?: readonly string[],
  options: { exceptOrderId?: string } = {},
): SQL {
  return sql`
    SELECT o.customer_id,
           count(*)::int AS number_of_orders,
           coalesce(sum(o.amount_paid - o.amount_refunded) FILTER (WHERE o.status <> 'cancelled'),
                    0)::bigint AS amount_spent,
           count(*) FILTER (WHERE o.stage IN ('delivered', 'completed'))::int AS delivered_orders,
           -- Refused, though the courier then lost the parcel on its way back; lost alone when
           -- it never reached them.
           count(*) FILTER (WHERE o.stage IN ('returning', 'returned')
                               OR (o.stage = 'lost' AND ${REFUSED}))::int AS returned_orders,
           count(*) FILTER (WHERE o.stage = 'lost' AND NOT ${REFUSED})::int AS lost_orders,
           count(*) FILTER (WHERE o.stage = 'cancelled')::int AS cancelled_orders,
           min(o.created_at) AS first_order_at,
           max(o.created_at) AS last_order_at,
           (array_agg(o.shipping_address ->> 'city' ORDER BY o.id DESC))[1] AS city,
           (array_agg(o.shipping_address ->> 'provinceCode' ORDER BY o.id DESC))[1]
             AS province_code
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND o.merged_into_id IS NULL
       ${customerIds ? sql`AND o.customer_id = ANY(${sql.param([...customerIds])}::uuid[])` : sql``}
       ${options.exceptOrderId ? sql`AND o.id <> ${options.exceptOrderId}` : sql``}
     GROUP BY o.customer_id`;
}

/** Order fields for segments; `order_facts` is {@link customerFactsQuery} per customer. */
export const ORDER_SEGMENT_FACTS: SegmentFactSource = {
  key: 'order_facts',
  query: (shopId) => customerFactsQuery(shopId),
  fields: [
    {
      name: 'number_of_orders',
      type: 'number',
      description: 'Orders placed, cancelled ones included.',
      example: 'number_of_orders >= 2',
      label: 'Orders',
      sql: sql`coalesce(order_facts.number_of_orders, 0)`,
    },
    {
      name: 'amount_spent',
      type: 'money',
      description: 'What they paid on orders that were not cancelled, less refunds.',
      example: 'amount_spent > 10000',
      label: 'Amount spent',
      sql: sql`coalesce(order_facts.amount_spent, 0)`,
    },
    {
      name: 'first_order_date',
      type: 'date',
      description: 'When they first ordered.',
      example: 'first_order_date > -30d',
      label: 'First order',
      sql: sql`order_facts.first_order_at`,
    },
    {
      name: 'last_order_date',
      type: 'date',
      description: 'When they last ordered.',
      example: 'last_order_date < -60d',
      label: 'Last order',
      sql: sql`order_facts.last_order_at`,
    },
    {
      name: 'delivered_orders',
      type: 'number',
      description: 'Orders delivered, paid for or not.',
      example: 'delivered_orders >= 1',
      label: 'Delivered orders',
      sql: sql`coalesce(order_facts.delivered_orders, 0)`,
    },
    {
      name: 'returned_orders',
      type: 'number',
      description: 'Orders refused at the door or undeliverable: coming back, or back.',
      example: 'returned_orders >= 1',
      label: 'Returned orders',
      sql: sql`coalesce(order_facts.returned_orders, 0)`,
    },
    {
      name: 'cancelled_orders',
      type: 'number',
      description: 'Orders cancelled before shipping.',
      example: 'cancelled_orders = 0',
      label: 'Cancelled orders',
      sql: sql`coalesce(order_facts.cancelled_orders, 0)`,
    },
    {
      name: 'city',
      type: 'text',
      description:
        'Where their latest order went. Known cities can be written any common way: lhr, Pindi.',
      example: "city IN (Lahore, Islamabad, 'Rahim Yar Khan')",
      label: 'City',
      sql: sql`order_facts.city`,
      normalize: (value) => findCity(value)?.name ?? value,
    },
    {
      name: 'province',
      type: 'text',
      description: 'The province of their latest order: a code, name or alias, like PB or KPK.',
      example: 'province = Punjab',
      label: 'Province',
      sql: sql`order_facts.province_code`,
      normalize: (value) => findProvince(value),
      invalidValue: 'is not a province or territory of Pakistan',
    },
  ],
};

/** Adds the order fields to segments when the application starts. */
@Injectable()
export class OrderSegmentFacts implements OnModuleInit {
  constructor(private readonly registry: SegmentFieldRegistry) {}

  onModuleInit(): void {
    this.registry.register(ORDER_SEGMENT_FACTS);
  }
}
