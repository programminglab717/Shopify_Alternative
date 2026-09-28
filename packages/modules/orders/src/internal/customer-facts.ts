import { SegmentFieldRegistry, type SegmentFactSource } from '@hatti/customers/public';
import { findCity, findProvince } from '@hatti/pk';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

/**
 * What each customer's orders add up to, one row per customer with orders: the single definition
 * behind a customer's stats (ADR-023) and the order fields of segments. Only `customerIds`, if
 * given; otherwise every customer of the shop.
 *
 * Amounts are minor units. Cancelled orders count as orders, but what was paid on them does not
 * count as spent. Where a customer is is where their latest order went.
 */
export function customerFactsQuery(shopId: string, customerIds?: readonly string[]): SQL {
  return sql`
    SELECT o.customer_id,
           count(*)::int AS number_of_orders,
           coalesce(sum(o.amount_paid) FILTER (WHERE o.status <> 'cancelled'), 0)::bigint
             AS amount_spent,
           count(*) FILTER (WHERE o.stage IN ('delivered', 'completed'))::int AS delivered_orders,
           count(*) FILTER (WHERE o.stage = 'returned')::int AS returned_orders,
           count(*) FILTER (WHERE o.stage = 'cancelled')::int AS cancelled_orders,
           min(o.created_at) AS first_order_at,
           max(o.created_at) AS last_order_at,
           (array_agg(o.shipping_address ->> 'city' ORDER BY o.id DESC))[1] AS city,
           (array_agg(o.shipping_address ->> 'provinceCode' ORDER BY o.id DESC))[1]
             AS province_code
      FROM orders.orders o
     WHERE o.shop_id = ${shopId}
       ${customerIds ? sql`AND o.customer_id = ANY(${sql.param([...customerIds])}::uuid[])` : sql``}
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
      sql: sql`coalesce(order_facts.number_of_orders, 0)`,
    },
    {
      name: 'amount_spent',
      type: 'money',
      description: 'What they paid on orders that were not cancelled.',
      example: 'amount_spent > 10000',
      sql: sql`coalesce(order_facts.amount_spent, 0)`,
    },
    {
      name: 'first_order_date',
      type: 'date',
      description: 'When they first ordered.',
      example: 'first_order_date > -30d',
      sql: sql`order_facts.first_order_at`,
    },
    {
      name: 'last_order_date',
      type: 'date',
      description: 'When they last ordered.',
      example: 'last_order_date < -60d',
      sql: sql`order_facts.last_order_at`,
    },
    {
      name: 'delivered_orders',
      type: 'number',
      description: 'Orders delivered, paid for or not.',
      example: 'delivered_orders >= 1',
      sql: sql`coalesce(order_facts.delivered_orders, 0)`,
    },
    {
      name: 'returned_orders',
      type: 'number',
      description: 'Orders refused at the door or undeliverable, that came back.',
      example: 'returned_orders >= 1',
      sql: sql`coalesce(order_facts.returned_orders, 0)`,
    },
    {
      name: 'cancelled_orders',
      type: 'number',
      description: 'Orders cancelled before shipping.',
      example: 'cancelled_orders = 0',
      sql: sql`coalesce(order_facts.cancelled_orders, 0)`,
    },
    {
      name: 'city',
      type: 'text',
      description:
        'Where their latest order went. Known cities can be written any common way: lhr, Pindi.',
      example: "city IN (Lahore, Islamabad, 'Rahim Yar Khan')",
      sql: sql`order_facts.city`,
      normalize: (value) => findCity(value)?.name ?? value,
    },
    {
      name: 'province',
      type: 'text',
      description: 'The province of their latest order: a code, name or alias, like PB or KPK.',
      example: 'province = Punjab',
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
