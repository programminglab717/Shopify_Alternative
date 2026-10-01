-- 0037 · Discount codes at checkout
-- A cart keeps the code its shopper applied, and an order the codes it was placed with. The
-- pricing module counts each use of a code with the order and its customer, so that no code is
-- used past its limit, or twice by a customer meant to use it once. See ADR-063 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE checkout.carts ADD COLUMN discount_codes text[] NOT NULL DEFAULT '{}';

-- Codes a checkout's page was given that took nothing off: past a few, it takes no more, so
-- that codes cannot be guessed.
ALTER TABLE checkout.checkouts
  ADD COLUMN discount_attempts smallint NOT NULL DEFAULT 0 CHECK (discount_attempts >= 0);

ALTER TABLE orders.orders ADD COLUMN discount_codes text[] NOT NULL DEFAULT '{}';

CREATE TABLE pricing.discount_redemptions (
  shop_id     uuid        NOT NULL,
  code_id     uuid        NOT NULL,
  -- No foreign key: orders belong to the orders module.
  order_id    uuid        NOT NULL,
  -- The order's customer, for codes a customer may use once; merging customers moves it.
  customer_id uuid        NOT NULL,
  -- What the code took off the order, its items and its delivery together.
  amount      bigint      NOT NULL CHECK (amount >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, code_id, order_id),
  FOREIGN KEY (shop_id, code_id) REFERENCES pricing.discount_codes (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX discount_redemptions_customer_idx
  ON pricing.discount_redemptions (shop_id, code_id, customer_id);

SELECT platform.enable_tenant_isolation('pricing.discount_redemptions');
