-- 0040 · Landmarks of their own in addresses
-- An address keeps its area in its second line, as Pakistani addresses are written and Shopify's
-- apps read them, and the landmark near it in a field of its own, which checkout and customers'
-- links now ask for (CHK-02). Addresses kept before have none: their second line stays as it was,
-- often a landmark typed where the area now goes. See ADR-070 in
-- docs/architecture/13-decision-log.md.

UPDATE orders.orders
   SET shipping_address = shipping_address || '{"landmark": null}'::jsonb
 WHERE NOT shipping_address ? 'landmark';

UPDATE orders.draft_orders
   SET shipping_address = shipping_address || '{"landmark": null}'::jsonb
 WHERE shipping_address IS NOT NULL AND NOT shipping_address ? 'landmark';
