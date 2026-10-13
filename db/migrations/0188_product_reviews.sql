-- 0188 · Product reviews (MKT-05)
-- A customer whose order was delivered rates what they bought, product by product, on the order's
-- own page: stars and, if they like, a few words. Each is a verified buyer's review of that
-- product, one an order and product, which they may change. A review waits for the shop unless
-- its stars are as many as the shop publishes by itself; the shop publishes or hides each.
-- See ADR-399 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.product_reviews (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  product_id   uuid        NOT NULL,
  -- The order it was written for, and its customer: a verified buyer.
  order_id     uuid        NOT NULL,
  customer_id  uuid,
  -- As the shop shows it: their first name and their surname's initial, "Ayesha K."
  author_name  text        NOT NULL CHECK (length(author_name) BETWEEN 1 AND 100),
  rating       smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body         text        CHECK (length(body) BETWEEN 1 AND 2000),
  status       text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'published', 'hidden')),
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE,
  UNIQUE (shop_id, order_id, product_id),
  CONSTRAINT product_reviews_published_check CHECK ((status = 'published') = (published_at IS NOT NULL))
);
-- A product's reviews as the storefront shows them, and the shop's to moderate.
CREATE INDEX product_reviews_product_idx
  ON catalog.product_reviews (shop_id, product_id, status, created_at DESC);
CREATE INDEX product_reviews_status_idx
  ON catalog.product_reviews (shop_id, status, created_at DESC, id DESC);
CREATE INDEX product_reviews_customer_idx
  ON catalog.product_reviews (shop_id, customer_id) WHERE customer_id IS NOT NULL;
SELECT platform.enable_tenant_isolation('catalog.product_reviews');

-- How the shop takes reviews: those of as many stars as `publish_from` publish by themselves
-- (null: every one waits for the shop).
CREATE TABLE catalog.review_settings (
  shop_id      uuid        PRIMARY KEY,
  publish_from smallint    CHECK (publish_from BETWEEN 1 AND 5),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
SELECT platform.enable_tenant_isolation('catalog.review_settings');
