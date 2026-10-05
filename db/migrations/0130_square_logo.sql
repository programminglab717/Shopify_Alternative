-- 0130 · The shop's square logo
-- Shopify's shop.brand.square_logo, beside its logo (ADR-081): one of the shop's files, an image,
-- for the places that show a square, as the top of its link page (CH-07). Deleting the file takes
-- it away. See ADR-205 in docs/architecture/13-decision-log.md.

ALTER TABLE files.brands
  ADD COLUMN square_logo_file_id uuid,
  ADD FOREIGN KEY (shop_id, square_logo_file_id) REFERENCES files.files (shop_id, id)
    ON DELETE SET NULL (square_logo_file_id);
