-- 0175 · Bookings still waiting to be picked up
-- The parcels a courier has not yet taken, as its tracking says: those a pickup claims, the
-- account's load sheet lists, and those handed to a rider that the courier's tracking still has
-- not seen (SHP-02, SHP-04), found without reading every booking the shop ever made. See ADR-379
-- in docs/architecture/13-decision-log.md.

CREATE INDEX bookings_waiting ON logistics.bookings (shop_id, account_id, booked_at)
  WHERE status = 'booked' AND parcel_status = 'booked';
