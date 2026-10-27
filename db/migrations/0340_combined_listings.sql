-- 0340 · Combined listings
-- Products a shop shows as one listing (CAT-23), as Shopify's combined listings do: each product
-- a value of the listing's option, such as its colour, its page offering the others as that
-- option's other values. A product is in one listing at most.
-- See ADR-799 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.combined_listings (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- What its products differ by, as its pages name the option: "Colour".
  option_name text        NOT NULL CHECK (length(option_name) BETWEEN 1 AND 255),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);
SELECT platform.enable_tenant_isolation('catalog.combined_listings');

CREATE TABLE catalog.combined_listing_products (
  shop_id    uuid     NOT NULL,
  listing_id uuid     NOT NULL,
  product_id uuid     NOT NULL,
  -- Its value of the listing's option: "Maroon".
  value      text     NOT NULL CHECK (length(value) BETWEEN 1 AND 255),
  -- Where it comes among the listing's products, from 0.
  position   smallint NOT NULL CHECK (position BETWEEN 0 AND 99),
  PRIMARY KEY (shop_id, product_id),
  UNIQUE (shop_id, listing_id, position),
  FOREIGN KEY (shop_id, listing_id)
    REFERENCES catalog.combined_listings (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);
-- Each value once a listing, whatever its case.
CREATE UNIQUE INDEX combined_listing_products_value_idx
  ON catalog.combined_listing_products (shop_id, listing_id, lower(value));
SELECT platform.enable_tenant_isolation('catalog.combined_listing_products');
