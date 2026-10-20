-- 0282 · Refunds for customer returns
-- A refund may say which customer return it gives money back for (ORD-07, ORD-09): what was paid
-- for the items coming back, as the return reckons it, given back in cash, by transfer or as store
-- credit, at most what of that is not refunded yet. A refund by exchange is its return's too.
-- See ADR-613 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.refunds
  ADD COLUMN return_id uuid,
  -- Deferred: an exchange's refund is written before its return, in the same transaction.
  ADD CONSTRAINT refunds_return_fkey FOREIGN KEY (shop_id, return_id)
    REFERENCES orders.returns (shop_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX refunds_return_idx ON orders.refunds (shop_id, return_id)
  WHERE return_id IS NOT NULL;

-- Refunds by exchange made before now are their returns'.
UPDATE orders.refunds r
   SET return_id = rt.id
  FROM orders.returns rt, orders.orders x
 WHERE r.method = 'exchange' AND rt.shop_id = r.shop_id AND rt.order_id = r.order_id
   AND x.shop_id = rt.shop_id AND x.id = rt.exchange_order_id
   AND r.reference = '#' || x.number;
