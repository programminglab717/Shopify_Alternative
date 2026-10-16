-- 0200 · Back in stock
-- A shopper who finds a variant sold out on the storefront may leave their mobile number to hear,
-- once, on WhatsApp when it is for sale online again (MKT-04): a recipe of the shop's automations
-- (ADR-425), which it turns on and off, sent from Hatti's shared number with the product and a
-- link to it, as checkout's reminder is, so it needs no template of the shop's own. A shopper's
-- wish is kept until they are told, or for 90 days.
-- See ADR-429 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.automations
  DROP CONSTRAINT automations_kind_check,
  ADD CONSTRAINT automations_kind_check
    CHECK (kind IN ('welcome', 'win_back', 'back_in_stock')),
  -- Back in stock sends Hatti's own template; the others the shop's, chosen before they are on.
  DROP CONSTRAINT automations_check,
  ADD CONSTRAINT automations_template_check
    CHECK (CASE WHEN kind = 'back_in_stock' THEN template_id IS NULL
                ELSE NOT enabled OR template_id IS NOT NULL END);

CREATE TABLE messaging.stock_watches (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL,
  -- The catalog's variant, and its product, as the storefront's page showed them.
  variant_id  uuid        NOT NULL,
  product_id  uuid        NOT NULL,
  -- A Pakistani mobile, as the messages keep numbers.
  phone       text        NOT NULL CHECK (phone ~ '^\+92[0-9]{10}$'),
  -- The storefront's language the shopper asked in, the message's.
  language    text        NOT NULL CHECK (language IN ('en', 'ur')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- When they were told; kept a while after, for the shop's counts.
  notified_at timestamptz,
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('messaging.stock_watches');

-- A number waits for a variant once; told, it may ask again.
CREATE UNIQUE INDEX stock_watches_waiting_key ON messaging.stock_watches
  (shop_id, variant_id, phone) WHERE notified_at IS NULL;
-- An erased customer's wishes go with their numbers.
CREATE INDEX stock_watches_phone_idx ON messaging.stock_watches (shop_id, phone);
