-- 0174 · Parcels handed to a courier's rider by hand
-- A rider comes on the courier's daily round, or for a courier whose API takes no pickups: staff
-- record the hand-over as a pickup kept here alone, of the parcels waiting, without asking the
-- courier, so that its load sheet lists them and each is checked off as the rider takes it
-- (SHP-02, APP-04). See ADR-378 in docs/architecture/13-decision-log.md.

ALTER TABLE logistics.pickups
  ADD COLUMN by_hand boolean NOT NULL DEFAULT false;
