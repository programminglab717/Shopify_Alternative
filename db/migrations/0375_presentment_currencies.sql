-- 0375 · Prices shown in shoppers' own currencies (OS-21, ADR-865)
-- A shop sells and charges in rupees, and shows shoppers abroad its prices in their currency as
-- well: the currencies it offers, each at a rate it fixes, rupees for one unit, or at the day's
-- rate, rounded as it asks. The day's rates are Hatti's, from an open currency feed the worker
-- reads; they belong to no shop, so the system login writes them and every shop reads them.

CREATE TABLE online_store.presentment_currencies (
  shop_id    uuid          NOT NULL,
  currency   text          NOT NULL CHECK (currency IN ('AED', 'SAR', 'GBP', 'USD', 'CAD', 'EUR')),
  -- Rupees for one unit, as the shop fixes it; null to follow the day's rate.
  fixed_rate numeric(10, 4) CHECK (fixed_rate > 0),
  rounding   text          NOT NULL DEFAULT 'exact'
                           CHECK (rounding IN ('exact', 'whole', 'ninety_nine')),
  -- Where the shop's picker lists it, from 0.
  position   integer       NOT NULL CHECK (position >= 0),
  created_at timestamptz   NOT NULL DEFAULT now(),
  updated_at timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, currency)
);

SELECT platform.enable_tenant_isolation('online_store.presentment_currencies');

CREATE TABLE platform.currency_rates (
  currency   text          PRIMARY KEY
                           CHECK (currency IN ('AED', 'SAR', 'GBP', 'USD', 'CAD', 'EUR')),
  -- Rupees for one unit, on the feed's day.
  rate       numeric(10, 4) NOT NULL CHECK (rate > 0),
  rate_date  date          NOT NULL,
  fetched_at timestamptz   NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON platform.currency_rates TO hatti_system_role;
GRANT SELECT ON platform.currency_rates TO hatti_app_role;
