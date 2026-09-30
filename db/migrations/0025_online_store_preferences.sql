-- 0025 · Online store preferences
-- What a shop sets for its storefront as a whole, a row per shop once it sets any: for now, the
-- WhatsApp number its "Order on WhatsApp" links and WhatsApp section go to. See ADR-041 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE online_store.preferences (
  shop_id    uuid        PRIMARY KEY,
  -- E.164, a Pakistani mobile number for now: +923001234567.
  whatsapp   text        CHECK (whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('online_store.preferences');
