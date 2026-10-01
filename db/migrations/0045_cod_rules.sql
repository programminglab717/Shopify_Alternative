-- 0045 · Cash on delivery's rules
-- A shop keeps cash on delivery to the orders it trusts (CHK-07): up to a total of its own,
-- outside cities it names, and not for customers who refused this many parcels before. Checkout
-- offers them bank transfer instead, or says why it can't take the order; orders staff and apps
-- place are the shop's own call. A row per shop once it sets any. See ADR-075 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE checkout.cod_settings (
  shop_id            uuid        PRIMARY KEY,
  -- Minor units; null for no limit but the law's.
  max_total          bigint      CHECK (max_total > 0),
  -- As @hatti/pk spells them: "Gilgit".
  unavailable_cities text[]      NOT NULL DEFAULT '{}'
                                 CHECK (cardinality(unavailable_cities) <= 200),
  -- Customers who refused this many parcels, or more, pay another way; null for no limit.
  refusals_limit     smallint    CHECK (refusals_limit BETWEEN 1 AND 100),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('checkout.cod_settings');
