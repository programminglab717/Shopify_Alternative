-- 0331 · Days a shop does not deliver on
-- A bakery closed on Mondays, a florist resting on Fridays: checkout offers no delivery slots on
-- the days of the week a shop says it does not deliver on, 0 for Sunday to 6 for Saturday
-- (CHK-15). See ADR-773 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.delivery_settings
  ADD COLUMN slot_closed_weekdays smallint[] NOT NULL DEFAULT '{}'
    CHECK (slot_closed_weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]);
