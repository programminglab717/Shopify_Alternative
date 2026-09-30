-- 0032 · Storefront password
-- A shop's storefront can be closed behind a password until it opens, as a new Shopify store's
-- is: shoppers see only its password page until they give it. See ADR-054 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  -- Whether the storefront is closed behind the password.
  ADD COLUMN password_enabled  boolean NOT NULL DEFAULT false,
  -- The password, sealed with the platform's secret box, so the shop's staff can see it again.
  ADD COLUMN password_sealed   text,
  -- What the storefront checks what shoppers type against: `scrypt$N$r$p$salt$key`.
  ADD COLUMN password_verifier text,
  -- What the password page tells shoppers, as the shop typed it.
  ADD COLUMN password_message  text    NOT NULL DEFAULT '' CHECK (length(password_message) <= 1000),
  ADD CONSTRAINT preferences_password_check CHECK (
    (password_sealed IS NULL) = (password_verifier IS NULL)
    AND (NOT password_enabled OR password_verifier IS NOT NULL)
  );
