import { CustomerDataRegistry, type CustomerDataHandler } from '@hatti/customers/public';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { actorColumns } from './order-store.js';
import { orderName } from './rules.js';

/** The most open orders a refused erasure names. */
const NAMED = 5;

/**
 * Orders' part in merging and erasing customers. A merged duplicate's orders become the
 * customer's. An erased customer's orders keep what the shop's accounts need: the items, amounts,
 * statuses and dates, and the city and province they went to; the name, number, email, street
 * and note go, as do the address and browser they were placed from and the notes and references
 * of their refunds, and the timeline says so. The policies they agreed to stay: those are the
 * shop's words, not the customer's (ADR-057).
 * Timeline messages never hold contact details, so they stay as they are. Their orders' links
 * stop working, since their pages show the address. Their draft orders go: those that became
 * their orders, and open ones with one of their numbers or their email.
 */
export const ORDER_CUSTOMER_DATA: CustomerDataHandler = {
  key: 'orders',

  async erasureBlockers(tx, shopId, customerId) {
    const { rows } = await tx.execute<{ number: number }>(sql`
      SELECT number FROM orders.orders
       WHERE shop_id = ${shopId} AND customer_id = ${customerId} AND status = 'open'
       ORDER BY number
       LIMIT ${NAMED + 1}`);
    if (rows.length === 0) return [];
    const named = rows.slice(0, NAMED).map((row) => orderName(row.number));
    return [
      'Their orders must be closed or cancelled first; still open: ' +
        named.join(', ') +
        (rows.length > NAMED ? ' and more' : ''),
    ];
  },

  async merge(tx, shopId, fromId, intoId) {
    await tx.execute(sql`
      UPDATE orders.orders
         SET customer_id = ${intoId}, version = version + 1, updated_at = now()
       WHERE shop_id = ${shopId} AND customer_id = ${fromId}`);
  },

  async erase(tx, shopId, customer, actor) {
    const customerId = customer.id;
    const { actorKind, actorId } = actorColumns(actor);
    // Drafts name no customer, and a completed one holds its order's address: they go first.
    await tx.execute(sql`
      DELETE FROM orders.draft_orders d
       WHERE d.shop_id = ${shopId}
         AND (d.phone = ANY(${sql.param(customer.phones)}::text[])
              OR lower(d.email) = lower(${customer.email}::text)
              OR d.order_id IN (SELECT o.id FROM orders.orders o
                                 WHERE o.shop_id = ${shopId} AND o.customer_id = ${customerId}))`);
    await tx.execute(sql`
      WITH erased AS (
        UPDATE orders.orders
           SET phone = NULL, email = NULL, note = '', search_text = '',
               link_token_hash = NULL, link_expires_at = NULL,
               client_ip = NULL, client_user_agent = NULL,
               shipping_address = jsonb_build_object(
                 'name', NULL, 'phone', NULL, 'address1', NULL, 'address2', NULL,
                 'landmark', NULL, 'city', shipping_address -> 'city',
                 'provinceCode', shipping_address -> 'provinceCode', 'zip', NULL),
               customer_erased_at = now(), version = version + 1, updated_at = now()
         WHERE shop_id = ${shopId} AND customer_id = ${customerId}
        RETURNING id),
      -- A refund's note and reference may name the customer or their wallet; the amount stays.
      cleared AS (
        UPDATE orders.refunds r
           SET note = '', reference = NULL
          FROM erased
         WHERE r.shop_id = ${shopId} AND r.order_id = erased.id),
      -- So may an agent's note on a call; how the call went stays.
      calls AS (
        UPDATE orders.confirmation_calls c
           SET note = ''
          FROM erased
         WHERE c.shop_id = ${shopId} AND c.order_id = erased.id)
      INSERT INTO orders.order_events (shop_id, id, order_id, kind, message, actor_kind, actor_id)
      SELECT ${shopId}, platform.uuidv7(), id, 'erased',
             'The customer''s details were erased at their request', ${actorKind}, ${actorId}
        FROM erased`);
  },
};

/** Adds orders to merges and erasure when the application starts. */
@Injectable()
export class OrderCustomerData implements OnModuleInit {
  constructor(private readonly registry: CustomerDataRegistry) {}

  onModuleInit(): void {
    this.registry.register(ORDER_CUSTOMER_DATA);
  }
}
