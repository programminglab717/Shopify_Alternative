-- 0050 · Receipts for transfers
-- A customer sends the receipt of their bank transfer through their order's page (PAY-02): a
-- photo, a screenshot or a PDF, which the shop sees with the order before marking it paid. Kept
-- in object storage under the shop's prefix (ADR-079); a row for each, at most five an order.
-- An erasure of the customer takes them. See ADR-080 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.transfer_receipts (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL,
  order_id     uuid        NOT NULL,
  -- Where storage keeps it: shops/{shop_id}/receipts/{order_id}/{id}.{extension}.
  key          text        NOT NULL
               CHECK (key LIKE 'shops/' || shop_id || '/receipts/' || order_id || '/' || id || '.%'),
  content_type text        NOT NULL
               CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp',
                                       'application/pdf')),
  -- Bytes; at most 10 MiB.
  size         integer     NOT NULL CHECK (size BETWEEN 1 AND 10485760),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX transfer_receipts_by_order
    ON orders.transfer_receipts (shop_id, order_id, created_at);

SELECT platform.enable_tenant_isolation('orders.transfer_receipts');
