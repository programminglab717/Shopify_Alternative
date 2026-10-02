-- 0096 · Orders paid online
-- A shopper who chooses to pay online at checkout places an order that waits for its total, as a
-- bank-transfer order does, until the shop's payment gateway says it is paid (PAY-01): its page
-- sends them to the gateway. Drafts are not paid so: their orders' pages take payments online.
-- See ADR-152 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders DROP CONSTRAINT orders_payment_method_check;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_payment_method_check
      CHECK (payment_method IN ('cash_on_delivery', 'prepaid', 'bank_transfer', 'online'));
