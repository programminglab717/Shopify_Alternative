-- 0342 · Stitching offered with a product
-- Unstitched eastern wear sold with stitching to the shopper's measurements (CAT-09): what it adds
-- to each unit's price, how many more days stitched pieces take to ship, and the measurements the
-- page asks for, in inches. A cart line stitched says so in its properties, which the order's line
-- keeps (ADR-687). See ADR-802 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.product_stitching (
  shop_id      uuid        NOT NULL,
  product_id   uuid        NOT NULL,
  -- What stitching adds to each unit's price, in minor units.
  price        bigint      NOT NULL CHECK (price >= 0),
  -- How many days more a stitched piece takes before it ships.
  lead_days    smallint    NOT NULL CHECK (lead_days BETWEEN 1 AND 60),
  -- The measurements the page asks for, by Hatti's keys, in order: {chest,waist,shirt_length}.
  measurements text[]      NOT NULL CHECK (cardinality(measurements) BETWEEN 1 AND 12),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, product_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('catalog.product_stitching');
