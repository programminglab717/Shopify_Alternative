-- 0020 · Draft links before the address
-- A draft's link can go out before the customer has given their address: its page asks for the
-- address, and for their number while the draft has none. A link still needs a cash-on-delivery
-- draft, which is what it confirms. See ADR-034 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.draft_orders
  DROP CONSTRAINT draft_orders_link_check,
  ADD CONSTRAINT draft_orders_link_check
    CHECK ((link_token_hash IS NULL) = (link_expires_at IS NULL)
           AND (link_token_hash IS NULL OR payment_method = 'cash_on_delivery'));
