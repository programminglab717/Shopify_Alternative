-- 0304 · What a storefront's search shows first, or leaves out, for a term
-- A shop pins products to the top of a search's results, "eid" its Eid edit, in its order, and
-- hides those it would not have a search show, as Shopify's Search & Discovery boosts and hides
-- them (SRC-04). See ADR-692 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.search_rules (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL,
  -- The term as the shop wrote it, and as the search folds it, words between single spaces.
  query      text        NOT NULL,
  query_key  text        NOT NULL CHECK (query_key <> ''),
  -- Products shown first, in this order, and products left out. The search reads only those
  -- still active, so products deleted since are passed over.
  pinned     uuid[]      NOT NULL DEFAULT '{}',
  hidden     uuid[]      NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, query_key)
);

SELECT platform.enable_tenant_isolation('catalog.search_rules');
