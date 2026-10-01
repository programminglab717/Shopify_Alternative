-- 0079 · Low stock
-- What a shop calls low stock: a variant with this many units for sale online or fewer (INV-01,
-- ADR-125). One setting a shop, kept by the inventory module; five until the shop says otherwise.
-- Which variants are low is worked out from the levels when asked, as the home's tallies are.

CREATE TABLE inventory.settings (
  shop_id             uuid        PRIMARY KEY,
  low_stock_threshold integer     NOT NULL CHECK (low_stock_threshold BETWEEN 0 AND 10000),
  version             integer     NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('inventory.settings');
