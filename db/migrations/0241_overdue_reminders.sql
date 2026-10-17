-- 0241 · Reminders while a period is overdue
-- A paid plan whose period ended unpaid stays a week before the shop is on Free (ADR-154). In
-- that week its owner is reminded three times, the day it ends, with three days left and with one
-- day left, each once (BIL-04): how many the period has had is kept with the subscription, and a
-- new period, or Free, starts it again from none.
-- See ADR-511 in docs/architecture/13-decision-log.md.

ALTER TABLE billing.subscriptions
  ADD COLUMN overdue_reminders smallint NOT NULL DEFAULT 0
    CHECK (overdue_reminders BETWEEN 0 AND 3);
