-- 0369 · Carts from WhatsApp's catalogue (CH-02)
-- A shop's WhatsApp catalogue is fed by its catalog feed (ADR-142), an item for each variant. A
-- customer who fills a cart there sends it to the shop's own number; the inbox keeps the cart,
-- each variant and how many, and the worker answers it once with a link to the shop's checkout
-- holding those items, the customer's number filled in, for them to finish the order.
-- See ADR-856 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.conversation_messages
  -- [{ "variantId": "…", "quantity": 2 }], as the catalogue named its items; null for others.
  ADD COLUMN cart             jsonb CHECK (cart IS NULL OR (jsonb_typeof(cart) = 'array'
                                                          AND jsonb_array_length(cart) BETWEEN 1 AND 50)),
  -- When the worker answered it with the checkout's link, or found nothing of it to sell.
  ADD COLUMN cart_answered_at timestamptz,
  ADD CHECK (cart_answered_at IS NULL OR cart IS NOT NULL);
