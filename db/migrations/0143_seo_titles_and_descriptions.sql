-- 0143 · Titles and descriptions for search engines
-- A product, collection, page or article may be given a title and a description of its own for
-- search engines and link previews, in place of its own title and the start of its text, as
-- Shopify's SEO has them (OS-09). Shopify's product CSV carries a product's as SEO Title and SEO
-- Description. Each is kept on one line; null for none. See ADR-231 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE catalog.products
  ADD COLUMN seo_title text CHECK (length(seo_title) BETWEEN 1 AND 255),
  ADD COLUMN seo_description text CHECK (length(seo_description) BETWEEN 1 AND 1000);

ALTER TABLE catalog.collections
  ADD COLUMN seo_title text CHECK (length(seo_title) BETWEEN 1 AND 255),
  ADD COLUMN seo_description text CHECK (length(seo_description) BETWEEN 1 AND 1000);

ALTER TABLE online_store.pages
  ADD COLUMN seo_title text CHECK (length(seo_title) BETWEEN 1 AND 255),
  ADD COLUMN seo_description text CHECK (length(seo_description) BETWEEN 1 AND 1000);

ALTER TABLE online_store.articles
  ADD COLUMN seo_title text CHECK (length(seo_title) BETWEEN 1 AND 255),
  ADD COLUMN seo_description text CHECK (length(seo_description) BETWEEN 1 AND 1000);
