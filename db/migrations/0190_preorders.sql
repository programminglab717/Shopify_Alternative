-- 0190 · Pre-orders (CAT-14)
-- A product the shop puts on pre-order sells whatever its stock, as if each of its variants kept
-- selling at zero, and says when it ships. The order's lines keep that date as it was when they
-- were sold. See ADR-403 in docs/architecture/13-decision-log.md.

CREATE TABLE inventory.preorders (
  shop_id    uuid        NOT NULL,
  product_id uuid        NOT NULL,
  -- The day the shop promises to send what is ordered now.
  ships_on   date        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, product_id),
  -- A pre-order is its product's, and goes with it, as stock goes with its variant.
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);
SELECT platform.enable_tenant_isolation('inventory.preorders');

-- The day each line was promised to ship, when its product was on pre-order as it was sold.
ALTER TABLE orders.lines ADD COLUMN preorder_ships_on date;
