-- 0280 · Store credit back with a parcel that came back
-- Where the shop says so, the store credit that paid an order goes back to its customer once the
-- order's every parcel came back unaccepted, as it does when the order is cancelled (ORD-09).
-- See ADR-610 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  ADD COLUMN credit_back_on_return boolean NOT NULL DEFAULT false;
