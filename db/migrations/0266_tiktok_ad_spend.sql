-- 0266 · Ad spend from TikTok
-- As a shop may connect its Meta ad account (ADR-564), it may now connect its TikTok advertiser
-- account with a long-term token from TikTok's Marketing API, and the same worker pulls each
-- day's spend there by campaign from TikTok's Business API, the last week's again each time. The
-- rules are Meta's: what the shop typed by hand stays its own. See ADR-566 in
-- docs/architecture/13-decision-log.md.

-- Pulled from TikTok's Business API too; each platform's pulled spend is of that platform alone.
ALTER TABLE marketing.ad_spend
  DROP CONSTRAINT ad_spend_source_check,
  ADD CONSTRAINT ad_spend_source_check CHECK (source IN ('manual', 'meta_api', 'tiktok_api')),
  ADD CONSTRAINT ad_spend_source_of_platform CHECK (source = 'manual' OR source = platform || '_api');

-- The shop's TikTok advertiser account, and a long-term token that reads its reports: as
-- marketing.meta_ad_accounts is Meta's.
CREATE TABLE marketing.tiktok_ad_accounts (
  shop_id         uuid        PRIMARY KEY,
  -- Its digits, as TikTok Ads Manager shows them.
  advertiser_id   text        NOT NULL CHECK (advertiser_id ~ '^[0-9]{5,25}$'),
  -- As TikTok named it and the currency it bills in, when it was connected.
  name            text        NOT NULL CHECK (char_length(name) <= 200),
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The time zone TikTok reports its days in, "Asia/Karachi"; null when TikTok gave none.
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

SELECT platform.enable_tenant_isolation('marketing.tiktok_ad_accounts');

-- The worker pulls those asked longest ago first.
CREATE INDEX tiktok_ad_accounts_attempt ON marketing.tiktok_ad_accounts (last_attempt_at NULLS FIRST);
