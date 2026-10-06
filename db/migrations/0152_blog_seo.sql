-- 0152 · A blog for search engines
-- A blog may be given a title and a description of its own for search engines and link previews,
-- in place of its own title, as Shopify's blogs have them as its pages' and articles' are (OS-09,
-- ADR-231). Each is kept on one line; null for none. See ADR-244 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE online_store.blogs
  ADD COLUMN seo_title text CHECK (length(seo_title) BETWEEN 1 AND 255),
  ADD COLUMN seo_description text CHECK (length(seo_description) BETWEEN 1 AND 1000);
