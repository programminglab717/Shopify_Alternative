-- 0333 · Price lists for wholesale customers
-- A shop's wholesale prices, for the customers it tags as such: a share off every item, prices
-- of its own for some variants, and more off as more of a variant is bought (CUS-06). See
-- ADR-778 in docs/architecture/13-decision-log.md.

CREATE TABLE pricing.price_lists (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL,
  name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- The customers it is for: those the shop gave this tag, in any letter case.
  customer_tag     text        NOT NULL CHECK (length(customer_tag) BETWEEN 1 AND 40),
  -- Off every item without a price of its own, in hundredths of a percent: 1000 is 10%.
  percent_off_bps  integer     NOT NULL DEFAULT 0 CHECK (percent_off_bps BETWEEN 0 AND 9000),
  -- More off as more of a variant is bought: [{"minQuantity": 12, "percentOffBps": 500}], at
  -- most five, the quantities rising.
  quantity_breaks  jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(quantity_breaks) = 'array'),
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

CREATE UNIQUE INDEX price_lists_tag_one ON pricing.price_lists (shop_id, lower(customer_tag));

SELECT platform.enable_tenant_isolation('pricing.price_lists');

-- A variant's price in a list, in place of the share off.
CREATE TABLE pricing.price_list_prices (
  shop_id        uuid    NOT NULL,
  price_list_id  uuid    NOT NULL,
  variant_id     uuid    NOT NULL,
  price          bigint  NOT NULL CHECK (price >= 0),
  PRIMARY KEY (shop_id, price_list_id, variant_id),
  FOREIGN KEY (shop_id, price_list_id) REFERENCES pricing.price_lists (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('pricing.price_list_prices');
