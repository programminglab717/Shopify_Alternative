-- 0151 · The home page for search engines
-- A shop's own title and description for its storefront's home page, as Shopify's preferences
-- keep its homepage title and meta description, and the image link previews show of pages without
-- one of their own, as its social sharing image (OS-09). The image is one of the shop's files: a
-- deleted one leaves none, without a key across schemas, as an article's image (ADR-213). See
-- ADR-243 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  ADD COLUMN seo_title           text CHECK (length(seo_title) BETWEEN 1 AND 255),
  ADD COLUMN seo_description     text CHECK (length(seo_description) BETWEEN 1 AND 1000),
  ADD COLUMN sharing_image_id    uuid,
  -- What it shows, for those who cannot see it; empty for its file's own.
  ADD COLUMN sharing_image_alt   text NOT NULL DEFAULT '' CHECK (length(sharing_image_alt) <= 512);
