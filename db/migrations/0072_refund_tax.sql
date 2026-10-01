-- What of each refund was sales tax (ADR-105): the order's tax in what has been refunded so far,
-- less what the refunds before it gave back, so that refunds of a whole order give back all its
-- tax.

ALTER TABLE orders.refunds ADD COLUMN tax bigint NOT NULL DEFAULT 0;

-- Refunds made before, worked out the same way, in the order they were made.
WITH running AS (
  SELECT r.shop_id, r.id, r.amount, o.total, o.total_tax,
         sum(r.amount) OVER (PARTITION BY r.shop_id, r.order_id
                             ORDER BY r.created_at, r.id) AS upto
    FROM orders.refunds r
    JOIN orders.orders o ON o.shop_id = r.shop_id AND o.id = r.order_id
   WHERE o.total > 0 AND o.total_tax > 0
)
UPDATE orders.refunds r
   SET tax = round(running.upto::numeric * running.total_tax / running.total)
           - round((running.upto - running.amount)::numeric * running.total_tax / running.total)
  FROM running
 WHERE r.shop_id = running.shop_id AND r.id = running.id;

ALTER TABLE orders.refunds
  ALTER COLUMN tax DROP DEFAULT,
  ADD CONSTRAINT refunds_tax_check CHECK (tax BETWEEN 0 AND amount);
