-- 0260 · Ad spend
-- What a shop spends on its ads each day (MKT-12, ANL-03), on Meta, TikTok, Google or elsewhere,
-- and on which campaign, as the shop records it in rupees: the sales report takes it off the
-- orders' profit and sets it against their sales. See ADR-553 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE marketing.ad_spend (
  shop_id    uuid        NOT NULL,
  platform   text        NOT NULL CHECK (platform IN ('meta', 'tiktok', 'google', 'other')),
  -- The day in the shop's own time zone.
  day        date        NOT NULL,
  -- The campaign as its links' utm_campaign names it; empty for the platform's day as a whole.
  campaign   text        NOT NULL DEFAULT '' CHECK (char_length(campaign) <= 200),
  -- In minor units of the shop's currency; a day of none is no row.
  amount     bigint      NOT NULL CHECK (amount > 0 AND amount <= 100000000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, platform, day, campaign)
);

SELECT platform.enable_tenant_isolation('marketing.ad_spend');
