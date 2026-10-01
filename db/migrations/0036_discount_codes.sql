-- 0036 · Discount codes
-- Codes a shop gives out for a percentage or an amount off an order's items, or for free
-- delivery, as Shopify's basic and free-shipping discount codes are (CHK-06): with a minimum, the
-- dates they work between, a limit on uses and one use a customer if the shop wants. Shoppers
-- type them in any letter case. The pricing module's, as price lists will be. See ADR-062 in
-- docs/architecture/13-decision-log.md.

CREATE SCHEMA pricing;

GRANT USAGE ON SCHEMA pricing TO hatti_app_role, hatti_system_role;

CREATE TABLE pricing.discount_codes (
  shop_id           uuid        NOT NULL,
  id                uuid        NOT NULL,
  -- As the shop wrote it: letters, digits, hyphens and underscores.
  code              text        NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{1,64}$'),
  title             text        NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  kind              text        NOT NULL
                    CHECK (kind IN ('percentage', 'fixed_amount', 'free_shipping')),
  -- Hundredths of a percent off the order's items: 1050 is 10.5%. Percentage codes only.
  percentage_bps    integer     CHECK (percentage_bps BETWEEN 1 AND 10000),
  -- Off the order's items, in minor units of the shop's currency. Fixed-amount codes only.
  amount            bigint      CHECK (amount > 0),
  -- What the order's items must come to for the code to work.
  minimum_subtotal  bigint      CHECK (minimum_subtotal > 0),
  starts_at         timestamptz NOT NULL DEFAULT now(),
  ends_at           timestamptz,
  usage_limit       integer     CHECK (usage_limit > 0),
  once_per_customer boolean     NOT NULL DEFAULT false,
  -- Orders placed with it.
  used              integer     NOT NULL DEFAULT 0 CHECK (used >= 0),
  version           integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT discount_codes_value_check CHECK (
    (kind = 'percentage') = (percentage_bps IS NOT NULL)
    AND (kind = 'fixed_amount') = (amount IS NOT NULL)
  ),
  CONSTRAINT discount_codes_dates_check CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE UNIQUE INDEX discount_codes_code_key ON pricing.discount_codes (shop_id, lower(code));

SELECT platform.enable_tenant_isolation('pricing.discount_codes');
