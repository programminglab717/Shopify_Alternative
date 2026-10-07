-- 0162 · Delivery addresses' pins
-- An address may carry where the customer's phone was at it, a map pin (CHK-02), which checkout's
-- and customers' links' address forms add: `location`, its latitude and longitude, or null.
-- Addresses kept before have none. See ADR-259 in docs/architecture/13-decision-log.md.

UPDATE orders.orders
   SET shipping_address = shipping_address || '{"location": null}'::jsonb
 WHERE NOT shipping_address ? 'location';

UPDATE orders.draft_orders
   SET shipping_address = shipping_address || '{"location": null}'::jsonb
 WHERE shipping_address IS NOT NULL AND NOT shipping_address ? 'location';
