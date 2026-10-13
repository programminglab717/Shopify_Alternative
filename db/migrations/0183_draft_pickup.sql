-- Drafts the customer picks up (SHP-15, ADR-390): a draft taken in a chat, collected at a
-- location that offers pickup rather than shipped, as the order it becomes is.
ALTER TABLE orders.draft_orders
  ADD COLUMN delivery_method text NOT NULL DEFAULT 'shipping'
             CHECK (delivery_method IN ('shipping', 'pickup'));
