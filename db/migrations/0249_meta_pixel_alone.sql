-- 0249 · The Meta pixel alone
-- A shop on Starter loads the Meta pixel on its storefront without Meta's conversions API, which
-- is Growth's (BIL-01): its dataset has no access token, and its orders go to no conversions API.
-- A token and its hint come together, or neither. See ADR-531 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE marketing.meta_settings
  ALTER COLUMN access_token DROP NOT NULL,
  ALTER COLUMN token_hint DROP NOT NULL,
  ADD CONSTRAINT meta_settings_token_with_hint
    CHECK ((access_token IS NULL) = (token_hint IS NULL));
