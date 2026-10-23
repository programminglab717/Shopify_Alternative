-- 0335 · A collection's image
-- A collection may show one of its shop's files as its image, as Shopify's collection.image
-- (ADR-785), with words of its own for those who cannot see it, as an article does (ADR-213). The
-- file is the files module's: a deleted one leaves the collection without an image wherever it is
-- shown, without a key across schemas.

ALTER TABLE catalog.collections
  ADD COLUMN image_file_id uuid,
  ADD COLUMN image_alt text NOT NULL DEFAULT '';
