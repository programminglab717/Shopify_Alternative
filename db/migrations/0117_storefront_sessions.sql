-- 0117 · Storefront sessions
-- Each day's sessions on a shop's storefront, in the shop's time zone, and how many of them added
-- to the cart, reached checkout and placed an order, as Shopify's conversion funnel has them
-- (ANL-02). Storefronts count them in Valkey as shoppers' pages, carts and checkouts tell them;
-- the worker keeps each day's counts so far here, every minute. See ADR-180 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE online_store.session_days (
  shop_id          uuid        NOT NULL,
  -- In the shop's time zone.
  day              date        NOT NULL,
  sessions         integer     NOT NULL CHECK (sessions >= 0),
  added_to_cart    integer     NOT NULL CHECK (added_to_cart >= 0),
  reached_checkout integer     NOT NULL CHECK (reached_checkout >= 0),
  converted        integer     NOT NULL CHECK (converted >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, day)
);

SELECT platform.enable_tenant_isolation('online_store.session_days');
