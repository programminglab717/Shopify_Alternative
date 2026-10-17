-- 0225 · Order lines by product
-- The products bought together (SRC-05): a product's orders found from its lines, the other
-- products in those orders from theirs. See ADR-480 in docs/architecture/13-decision-log.md.

CREATE INDEX lines_product_idx ON orders.lines (shop_id, product_id, order_id);
