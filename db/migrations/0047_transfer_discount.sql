-- 0047 · Something off for paying by transfer
-- A shop may take a percentage, up to a cap, or an amount off orders paid by bank transfer
-- (CHK-08's prepaid incentive), which checkout takes off after any code. The order keeps it as
-- part of its discount, apart from the codes', so its pages and invoice can say what it is. See
-- ADR-077 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.bank_transfer_settings
  ADD COLUMN discount_bps integer CHECK (discount_bps BETWEEN 1 AND 5000),
  ADD COLUMN discount_cap bigint CHECK (discount_cap > 0),
  ADD COLUMN discount_amount bigint CHECK (discount_amount > 0),
  ADD CONSTRAINT bank_transfer_settings_discount_check
      CHECK ((discount_bps IS NULL OR discount_amount IS NULL)
             AND (discount_cap IS NULL OR discount_bps IS NOT NULL));

-- Minor units: the part of `discount` taken off for paying by transfer.
ALTER TABLE orders.orders ADD COLUMN transfer_discount bigint NOT NULL DEFAULT 0;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_transfer_discount_check
      CHECK (transfer_discount >= 0 AND transfer_discount <= discount
             AND (transfer_discount = 0 OR payment_method = 'bank_transfer'));
