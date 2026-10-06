-- 0149 · Options in Urdu
-- A product option's name and an option value's may be translated as the rest of a shop's content
-- is (ADR-238), by Shopify's key for them, name (OS-06). See ADR-241 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE online_store.translations
  DROP CONSTRAINT translations_key_check,
  ADD CONSTRAINT translations_key_check CHECK (key IN ('title', 'body_html', 'summary_html',
                                                       'product_type', 'meta_title',
                                                       'meta_description', 'body', 'name'));
