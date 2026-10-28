-- 0371 · Expansion stores (CH-11)
-- An owner with more than one shop, a Pakistani store and an international one say, makes one an
-- expansion store of another: its products copied from the first, their prices at a rate the
-- owner sets, as Shopify Plus's expansion stores are kept in step. Copied again, products the
-- expansion store has already are updated, and new ones added. Kept with the shop products come
-- from. See ADR-859 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.expansion_stores (
  shop_id        uuid          NOT NULL,
  -- The shop products are copied to: the same owner's.
  target_shop_id uuid          NOT NULL REFERENCES control.shops (id),
  -- What a price here is multiplied by there: 0.0036 for rupees to dollars.
  price_rate     numeric(14,6) NOT NULL CHECK (price_rate > 0 AND price_rate <= 1000000),
  synced_at      timestamptz,
  -- What the last copy did: products made and updated, and the rows it could not take.
  last_result    jsonb,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, target_shop_id),
  CHECK (target_shop_id <> shop_id)
);

SELECT platform.enable_tenant_isolation('catalog.expansion_stores');
