-- 0361 · Paying online at the door (PAY-09)
-- A cash-on-delivery order the shop's own rider takes out (ADR-825) may be paid online instead of
-- in cash at the door: its page offers what the rider would collect, and the rider shows the
-- customer a QR code of it. The order keeps which parcel is out at its door while it is; paid
-- online meanwhile, the cash to collect comes down, and the rider sees it. Couriers' parcels are
-- left out: no courier takes a change of the cash to collect once a parcel is booked.
-- See ADR-846 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders ADD COLUMN door_parcel_id uuid;

-- The order's page a delivery's rider last showed its customer as a QR code, its path with the
-- link's secret, to show again while it still works; null until one is shown. Kept as messages
-- keep the links they carry (ADR-160).
ALTER TABLE logistics.rider_deliveries ADD COLUMN door_link text
  CHECK (door_link LIKE '/o/%' AND char_length(door_link) <= 100);
