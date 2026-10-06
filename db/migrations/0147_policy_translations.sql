-- 0147 · A shop's policies in Urdu
-- A policy's body may be translated as the rest of a shop's content is (ADR-238), by Shopify's key
-- for it, body (OS-06, ONB-09). See ADR-239 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.translations
  DROP CONSTRAINT translations_key_check,
  ADD CONSTRAINT translations_key_check CHECK (key IN ('title', 'body_html', 'summary_html',
                                                       'product_type', 'meta_title',
                                                       'meta_description', 'body'));
