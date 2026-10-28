-- 0390 · An age gate
-- A shop selling what is only for adults asks each visitor their age before its storefront shows
-- (OS-15): those who say they are old enough are not asked again for a month; those who say they
-- are not see the store no further. Null: no gate. See ADR-889 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  ADD COLUMN age_gate_minimum smallint CHECK (age_gate_minimum BETWEEN 13 AND 25);
