-- 0278 · A shop's cut-off for the day's orders (CHK-05)
-- Orders placed at or after the hour a shop sets, in Pakistan's time, count their delivery days
-- from the next day, as they ship the day after; checkout's day to expect delivery by and the
-- order's promise say so. See ADR-597 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.delivery_settings
  ADD COLUMN cutoff_hour smallint CHECK (cutoff_hour BETWEEN 1 AND 23);
