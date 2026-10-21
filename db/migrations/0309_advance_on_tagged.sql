-- 0309 · An advance counted on the products it names alone
-- An advance asked of orders holding a product the shop tags may be counted on those products
-- alone: its share is of what they come to, and its amount at most that, so a shop selling
-- ready-made kurtas and suits stitched to measure asks a share of the suits (CHK-10). See ADR-712
-- in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.cod_settings
  ADD COLUMN advance_on_tagged boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT cod_settings_advance_on_tagged_check CHECK (
    NOT advance_on_tagged
    OR (cardinality(advance_product_tags) > 0 AND advance_kind IN ('fixed_amount', 'percentage')));
