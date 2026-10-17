-- 0243 · Automatic discounts
-- Discounts a shop gives without a code, as Shopify's automatic discounts are (CHK-06, V1): a
-- percentage or an amount off an order's items, or free delivery, with a minimum and the dates
-- they run between, taken by every cart and checkout that qualifies. The one that takes most off
-- the items applies, with free delivery beside it; with a code only where every one applied
-- combines with codes. Orders keep the titles of those they were placed with. See ADR-515 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE pricing.automatic_discounts (
  shop_id             uuid        NOT NULL,
  id                  uuid        NOT NULL,
  -- What shoppers see beside what it takes off: "Eid sale".
  title               text        NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  kind                text        NOT NULL
                      CHECK (kind IN ('percentage', 'fixed_amount', 'free_shipping')),
  -- Hundredths of a percent off the order's items: 1050 is 10.5%. Percentage discounts only.
  percentage_bps      integer     CHECK (percentage_bps BETWEEN 1 AND 10000),
  -- Off the order's items, in minor units of the shop's currency. Fixed-amount discounts only.
  amount              bigint      CHECK (amount > 0),
  -- What the order's items must come to for it to apply.
  minimum_subtotal    bigint      CHECK (minimum_subtotal > 0),
  starts_at           timestamptz NOT NULL DEFAULT now(),
  ends_at             timestamptz,
  -- Whether a discount code may be used with it.
  combines_with_codes boolean     NOT NULL DEFAULT false,
  version             integer     NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT automatic_discounts_value_check CHECK (
    (kind = 'percentage') = (percentage_bps IS NOT NULL)
    AND (kind = 'fixed_amount') = (amount IS NOT NULL)
  ),
  CONSTRAINT automatic_discounts_dates_check CHECK (ends_at IS NULL OR ends_at > starts_at)
);

SELECT platform.enable_tenant_isolation('pricing.automatic_discounts');

-- The automatic discounts an order was placed with, by their titles then.
ALTER TABLE orders.orders
  ADD COLUMN automatic_discounts text[] NOT NULL DEFAULT '{}';
