-- 0140 · Drafts paid by transfer, through their links
-- A draft to be paid by bank transfer gets a link too (PAY-04): its customer adds their address if
-- it has none and confirms it, which places the order to wait for its money, and the link becomes
-- the order's, whose page shows the shop's account, takes the receipt and offers paying online. A
-- prepaid draft still gets none. See ADR-223 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.draft_orders
  DROP CONSTRAINT draft_orders_link_check,
  ADD CONSTRAINT draft_orders_link_check
    CHECK ((link_token_hash IS NULL) = (link_expires_at IS NULL)
           AND (link_token_hash IS NULL
                OR payment_method IN ('cash_on_delivery', 'bank_transfer')));
