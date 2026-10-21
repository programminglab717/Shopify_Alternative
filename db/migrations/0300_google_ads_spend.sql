-- 0300 · Ad spend from Google Ads
-- As a shop may connect its Meta ad account (ADR-564) and TikTok advertiser account (ADR-566), it
-- may now connect its Google Ads account through Google's consent screen, Hatti keeping the grant
-- it gives, and the same worker pulls each day's spend there by campaign from the Google Ads API,
-- the last week's again each time. The rules are Meta's: what the shop typed by hand stays its
-- own. See ADR-678 in docs/architecture/13-decision-log.md.

-- Pulled from the Google Ads API too; each platform's pulled spend is of that platform alone.
ALTER TABLE marketing.ad_spend
  DROP CONSTRAINT ad_spend_source_check,
  ADD CONSTRAINT ad_spend_source_check
    CHECK (source IN ('manual', 'meta_api', 'tiktok_api', 'google_api'));

-- The shop's Google Ads account, and the refresh token of the grant its owner gave Hatti on
-- Google's consent screen: as marketing.meta_ad_accounts is Meta's.
CREATE TABLE marketing.google_ads_accounts (
  shop_id         uuid        PRIMARY KEY,
  -- Its ten digits, as Google Ads shows them without their dashes.
  customer_id     text        NOT NULL CHECK (customer_id ~ '^[0-9]{10}$'),
  -- As Google named it and the currency it bills in, when it was connected.
  name            text        NOT NULL CHECK (char_length(name) <= 200),
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The time zone Google reports its days in, "Asia/Karachi"; null when Google gave none.
  timezone        text        CHECK (char_length(timezone) <= 100),
  -- The grant's refresh token, sealed for the shop alone, and never shown again.
  access_token    text        NOT NULL,
  -- Its last four characters, to tell grants apart by.
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

SELECT platform.enable_tenant_isolation('marketing.google_ads_accounts');

-- The worker pulls those asked longest ago first.
CREATE INDEX google_ads_accounts_attempt ON marketing.google_ads_accounts (last_attempt_at NULLS FIRST);
