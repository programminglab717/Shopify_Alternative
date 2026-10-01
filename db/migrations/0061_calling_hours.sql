-- 0061 · Calling hours and the first call
-- A shop's Confirmation Desk keeps hours (COD-05): the time of day in which it calls customers,
-- when it deals out orders and when an unanswered one falls due again; and how long an order may
-- wait for its first call, counting those hours, before it is overdue. See ADR-091 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  -- Minutes after midnight in the shop's time zone; both null for any time.
  ADD COLUMN calling_opens smallint CHECK (calling_opens BETWEEN 0 AND 1380),
  ADD COLUMN calling_closes smallint CHECK (calling_closes BETWEEN 60 AND 1440),
  -- Minutes of calling hours; null for no target.
  ADD COLUMN first_call_minutes smallint CHECK (first_call_minutes BETWEEN 5 AND 1440),
  ADD CONSTRAINT order_settings_calling_hours_check CHECK (
    (calling_opens IS NULL) = (calling_closes IS NULL)
    AND calling_closes - calling_opens >= 60);
