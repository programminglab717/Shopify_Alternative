-- 0033 · robots.txt rules of a shop's own
-- Rules a shop adds to its storefront's robots.txt, as Shopify's robots.txt.liquid lets it: kept
-- as the online store checked them, one a line. See ADR-055 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  ADD COLUMN robots_txt_rules text NOT NULL DEFAULT '' CHECK (length(robots_txt_rules) <= 10000);
