-- 0247 · Support requests past their time
-- A request still open when its plan's time to answer has passed (BIL-05) is flagged to Hatti's
-- people once: the worker's sweep marks when, logs it and emails Hatti's support address the list.
-- See ADR-525 in docs/architecture/13-decision-log.md.

ALTER TABLE billing.support_requests ADD COLUMN overdue_at timestamptz;

-- What the sweep looks through: open requests not yet flagged, the oldest first.
CREATE INDEX support_requests_not_flagged ON billing.support_requests (created_at)
  WHERE status = 'open' AND overdue_at IS NULL;
