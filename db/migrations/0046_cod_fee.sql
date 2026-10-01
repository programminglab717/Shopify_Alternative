-- 0046 · Cash on delivery's fee
-- A shop may charge a fee for paying at the door (CHK-08), which checkout adds to orders paid on
-- delivery: the order keeps it apart from delivery, in its total and in the cash collected, so
-- slips, invoices and sales reports show it as what it is. See ADR-076 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE checkout.cod_settings
  ADD COLUMN fee bigint NOT NULL DEFAULT 0 CHECK (fee >= 0);

-- Minor units; only orders paid on delivery have one.
ALTER TABLE orders.orders ADD COLUMN cod_fee bigint NOT NULL DEFAULT 0;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_cod_fee_check
      CHECK (cod_fee >= 0 AND (cod_fee = 0 OR payment_method = 'cash_on_delivery'));
ALTER TABLE orders.orders DROP CONSTRAINT orders_total_check;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_total_check
      CHECK (discount <= subtotal AND total = subtotal - discount + shipping + cod_fee);
