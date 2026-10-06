-- 0134 · An article's image
-- An article may show one of its shop's files as its image, as Shopify's article.image (ADR-213),
-- with words of its own for those who cannot see it. The file is the files module's: a deleted
-- one leaves the article without an image wherever it is shown, without a key across schemas.

ALTER TABLE online_store.articles
  ADD COLUMN image_file_id uuid,
  ADD COLUMN image_alt text NOT NULL DEFAULT '';
