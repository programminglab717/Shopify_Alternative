-- 0248 · "Powered by Hatti"
-- Every storefront's footer says it is powered by Hatti (BIL-01), as Shopify's powered_by_link
-- does, unless the shop hides it on a plan that lets it: Starter and above. One hidden before
-- stays hidden on a smaller plan. See ADR-526 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  ADD COLUMN hide_powered_by boolean NOT NULL DEFAULT false;
