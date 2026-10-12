-- 0173 · A pickup's parcels handed over
-- Each parcel of a pickup checked off by scanning its tracking number as the courier's rider
-- takes it (SHP-02, APP-04): when, and by whom. Those not checked off are the ones still on the
-- table. See ADR-377 in docs/architecture/13-decision-log.md.

ALTER TABLE logistics.pickup_parcels
  ADD COLUMN handed_over_at      timestamptz,
  ADD COLUMN handed_over_by_kind text CHECK (handed_over_by_kind IN ('app', 'staff')),
  ADD COLUMN handed_over_by_id   text CHECK (char_length(handed_over_by_id) <= 100),
  ADD CONSTRAINT pickup_parcels_handed_over_check
    CHECK ((handed_over_at IS NULL) = (handed_over_by_kind IS NULL)
           AND (handed_over_at IS NULL) = (handed_over_by_id IS NULL));
