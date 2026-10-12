-- 0180 · Courier rules for the best value
-- A courier rule without an account picks one (ADR-385): the cheapest by the accounts' rate cards,
-- or the best value, the cheapest for each parcel delivered, weighing each card's price with how
-- often its courier delivers in the order's city (SHP-06, SHP-08). See ADR-387 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE logistics.courier_rules
  ADD COLUMN pick text CHECK (pick IN ('cheapest', 'best_value'));

UPDATE logistics.courier_rules SET pick = 'cheapest' WHERE account_id IS NULL;

ALTER TABLE logistics.courier_rules
  ADD CONSTRAINT courier_rules_pick_account_check CHECK ((account_id IS NULL) = (pick IS NOT NULL));
