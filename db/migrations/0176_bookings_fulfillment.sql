-- 0176 · Bookings found by their parcels
-- An order's page shows each of its parcels' last hand-over to its courier's rider, and what the
-- courier's tracking said since (SHP-02, SHP-04), found by the parcel's fulfillment rather than
-- by reading every booking the shop ever made. See ADR-381 in
-- docs/architecture/13-decision-log.md.

CREATE INDEX bookings_fulfillment ON logistics.bookings (shop_id, fulfillment_id)
  WHERE fulfillment_id IS NOT NULL;
