-- 0169 · A variant's purchase orders found by the variant
-- What of a variant is on order and who supplied it last are shown with what runs low (INV-05),
-- read from its purchase order lines.
-- See ADR-354 in docs/architecture/13-decision-log.md.

CREATE INDEX purchase_order_lines_variant_idx
  ON inventory.purchase_order_lines (shop_id, variant_id);
