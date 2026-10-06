-- 0150 · A refund's receipt
-- A refund staff sent by hand may keep its receipt, a photo, a screenshot or a PDF of the money
-- going back, as an order keeps those its customer sends for a transfer (ADR-080): among the
-- order's receipts in storage, gone with the customer's erasure as theirs are (ADR-113) (ORD-09).
-- See ADR-242 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.refunds
  -- Where storage keeps it: shops/{shop_id}/receipts/{order_id}/{id}.{extension}.
  ADD COLUMN receipt_key          text,
  ADD COLUMN receipt_content_type text,
  -- Bytes; at most 10 MiB, as a transfer's receipt.
  ADD COLUMN receipt_size         integer,
  ADD CONSTRAINT refunds_receipt_check CHECK (
    (receipt_key IS NULL AND receipt_content_type IS NULL AND receipt_size IS NULL)
    OR (receipt_key LIKE 'shops/' || shop_id || '/receipts/' || order_id || '/%'
        AND receipt_content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
        AND receipt_size BETWEEN 1 AND 10485760
        -- Money staff sent: not a gateway's, nor store credit, nor an exchange.
        AND method IN ('bank_transfer', 'mobile_wallet', 'cash', 'other')));
