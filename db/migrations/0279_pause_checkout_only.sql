-- 0279 · Checkout paused alone, the storefront browsable (OS-15)
-- A shop that pauses may keep its storefront open for shoppers to browse while checkout alone
-- takes no orders until it opens again. See ADR-603 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  ADD COLUMN maintenance_checkout_only boolean NOT NULL DEFAULT false;
