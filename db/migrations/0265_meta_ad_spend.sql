-- 0265 · Ad spend from Meta
-- Shops typed what they spend on ads by hand (ADR-553). Now a shop may connect its Meta ad account
-- with a token that reads it, and the worker pulls each day's spend there by campaign from Meta's
-- Marketing API every few hours, the last week's again each time, as Meta revises its recent
-- days. What the shop typed by hand stays its own. See ADR-564 in
-- docs/architecture/13-decision-log.md.

-- Where each day's spend came from: typed by the shop, or pulled from Meta's Marketing API. A row
-- typed by hand is never replaced by one pulled; typing over a pulled one makes it the shop's.
ALTER TABLE marketing.ad_spend
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'meta_api'));

-- The shop's Meta ad account, and a token that reads its spend (ads_read).
CREATE TABLE marketing.meta_ad_accounts (
  shop_id         uuid        PRIMARY KEY,
  -- Its digits, without "act_".
  ad_account_id   text        NOT NULL CHECK (ad_account_id ~ '^[0-9]{5,20}$'),
  -- As Meta named it and the currency it bills in, when it was connected.
  name            text        NOT NULL CHECK (char_length(name) <= 200),
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The time zone Meta reports its days in, "Asia/Karachi"; null when Meta gave none.
  timezone        text        CHECK (char_length(timezone) <= 100),
  -- Sealed for the shop alone, and never shown again.
  access_token    text        NOT NULL,
  -- Its last four characters, to tell tokens apart by.
  token_hint      text        NOT NULL CHECK (char_length(token_hint) = 4),
  -- When its spend was last asked for, however that went, and last pulled; null before the
  -- first, which pulls the last 30 days.
  last_attempt_at timestamptz,
  last_synced_at  timestamptz,
  -- Why the last pull failed; null when it went through.
  last_error      text        CHECK (char_length(last_error) <= 1000),
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('marketing.meta_ad_accounts');

-- The worker pulls those asked longest ago first.
CREATE INDEX meta_ad_accounts_attempt ON marketing.meta_ad_accounts (last_attempt_at NULLS FIRST);
