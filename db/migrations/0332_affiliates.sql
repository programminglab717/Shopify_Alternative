-- 0332 · Affiliates and influencers
-- People who send customers to a shop, by a link of their own (the storefront with ?ref=) or a
-- discount code of the shop's, earn a share of what the orders they bring come to, once
-- delivered; the shop records what it pays them (MKT-08). See ADR-776 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE orders.affiliates (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL,
  name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- Their mobile number, for the shop to reach them; none where it keeps none.
  phone            text        CHECK (length(phone) BETWEEN 1 AND 40),
  -- What their link carries: the storefront's address with ?ref= and this.
  ref              text        NOT NULL CHECK (ref ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  -- One of the shop's discount codes, as orders keep codes, upper case; none for a link alone.
  discount_code    text        CHECK (length(discount_code) BETWEEN 1 AND 50),
  -- Their share of what an order's items came to, in hundredths of a percent: 1000 is 10%.
  commission_bps   integer     NOT NULL CHECK (commission_bps BETWEEN 1 AND 5000),
  -- When the shop ended their part: orders placed after it earn them nothing.
  ended_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

CREATE UNIQUE INDEX affiliates_ref_one ON orders.affiliates (shop_id, ref);
CREATE UNIQUE INDEX affiliates_code_one ON orders.affiliates (shop_id, discount_code)
  WHERE discount_code IS NOT NULL;

SELECT platform.enable_tenant_isolation('orders.affiliates');

-- What the shop paid an affiliate, as it records it.
CREATE TABLE orders.affiliate_payouts (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL,
  affiliate_id uuid        NOT NULL,
  amount       bigint      NOT NULL CHECK (amount > 0),
  note         text        NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  paid_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, affiliate_id) REFERENCES orders.affiliates (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX affiliate_payouts_affiliate ON orders.affiliate_payouts (shop_id, affiliate_id, paid_at);

SELECT platform.enable_tenant_isolation('orders.affiliate_payouts');
