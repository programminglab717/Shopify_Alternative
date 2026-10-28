-- 0394 · The merchant copilot drafts broadcasts too (AI-01)
-- A request may be read into a broadcast, which staff confirm with its template (ADR-896).
-- See ADR-896 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.copilot_requests DROP CONSTRAINT copilot_requests_outcome_check;
ALTER TABLE orders.copilot_requests
  ADD CONSTRAINT copilot_requests_outcome_check
  CHECK (outcome IN ('discount', 'segment', 'broadcast', 'report', 'none', 'unchecked',
                     'refused', 'failed', 'invalid'));
