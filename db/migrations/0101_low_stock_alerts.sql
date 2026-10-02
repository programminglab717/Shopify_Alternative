-- 0101 · Low-stock alerts
-- The shop hears on WhatsApp when a variant runs low on stock, and again when it runs out (INV-01):
-- at the number it gives for Hatti's alerts, once for each spell of low stock, which lasts until
-- the variant is stocked above the shop's threshold again. See ADR-157 in
-- docs/architecture/13-decision-log.md.

-- Where Hatti's alerts to the shop go, in E.164; none sends none.
ALTER TABLE messaging.settings
  ADD COLUMN alerts_phone text CHECK (alerts_phone ~ '^\+[1-9][0-9]{6,14}$');

-- Each variant low on stock now: its spell began when it fell to the shop's threshold, and ends
-- when it rises above it, when the row goes.
CREATE TABLE inventory.low_stock_spells (
  shop_id    uuid        NOT NULL,
  variant_id uuid        NOT NULL,
  -- Low: some for sale online, the threshold or fewer; out: none.
  state      text        NOT NULL CHECK (state IN ('low', 'out')),
  -- Units for sale online when it last changed.
  available  integer     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, variant_id),
  CHECK ((state = 'out') = (available <= 0))
);

SELECT platform.enable_tenant_isolation('inventory.low_stock_spells');
