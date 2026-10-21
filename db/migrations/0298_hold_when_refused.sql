-- 0298 · Orders held when their customer refuses a parcel
-- Where the shop says so, a customer's other cash-on-delivery orders confirmed and waiting to be
-- packed or booked are held for review once a parcel of theirs turns back, refused or not
-- delivered, for staff to call them before it ships (COD-07).
-- See ADR-674 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  ADD COLUMN hold_when_refused boolean NOT NULL DEFAULT false;
