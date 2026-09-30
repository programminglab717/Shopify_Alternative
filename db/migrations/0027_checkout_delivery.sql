-- 0027 · Delivery charges
-- What a shop charges to deliver an order, which checkout adds: one charge for everywhere, zones
-- of cities with a charge of their own (the shop's own city, say), and a subtotal from which
-- delivery is free. A row per shop once it sets any, saved whole. See ADR-043 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE checkout.delivery_settings (
  shop_id    uuid        PRIMARY KEY,
  -- Minor units (paisa).
  charge     bigint      NOT NULL DEFAULT 0 CHECK (charge >= 0),
  free_above bigint      CHECK (free_above > 0),
  -- [{"name", "cities": [city names, as @hatti/pk spells them], "charge"}]; a city in one zone.
  zones      jsonb       NOT NULL DEFAULT '[]'
                         CHECK (jsonb_typeof(zones) = 'array' AND jsonb_array_length(zones) <= 20),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('checkout.delivery_settings');
