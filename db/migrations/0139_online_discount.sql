-- 0139 · Something off for paying online
-- A shop may take a percentage, up to a cap, or an amount off orders paid online at checkout, as
-- its prepaid incentive (PAY-05, CHK-08), as it may off orders paid by transfer (ADR-077): checkout
-- takes it off the items after any code. The order keeps it as part of its discount, apart from
-- the codes' and the transfer's, so its pages and invoice can say what it is. See ADR-222 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE payments.online_payment_settings (
  shop_id         uuid        PRIMARY KEY,
  -- Hundredths of a percent, with a cap or not; or an amount. Minor units.
  discount_bps    integer     CHECK (discount_bps BETWEEN 1 AND 5000),
  discount_cap    bigint      CHECK (discount_cap > 0),
  discount_amount bigint      CHECK (discount_amount > 0),
  version         integer     NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT online_payment_settings_discount_check
    CHECK ((discount_bps IS NULL OR discount_amount IS NULL)
           AND (discount_cap IS NULL OR discount_bps IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('payments.online_payment_settings');

-- Minor units: the part of `discount` taken off for paying online.
ALTER TABLE orders.orders ADD COLUMN online_discount bigint NOT NULL DEFAULT 0;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_online_discount_check
      CHECK (online_discount >= 0 AND transfer_discount + online_discount <= discount
             AND (online_discount = 0 OR payment_method = 'online'));
