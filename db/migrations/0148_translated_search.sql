-- 0148 · Search in Urdu
-- What a shop wrote in Urdu for its products, pages and articles (ADR-238), folded for the
-- storefront's search as their own words are, so a shopper finds them by either (OS-06,
-- SRC-01). Kept by the online store as their translations change. See ADR-240 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE catalog.products ADD COLUMN translated_text text NOT NULL DEFAULT '';
ALTER TABLE online_store.pages ADD COLUMN translated_text text NOT NULL DEFAULT '';
ALTER TABLE online_store.articles ADD COLUMN translated_text text NOT NULL DEFAULT '';
