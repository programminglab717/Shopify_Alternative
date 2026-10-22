-- 0312 · When a message became due
-- A message is due when it is queued, or at the time it was told to wait for (ADR-621); the
-- sender's metrics count how long after that it went, for the objective that order confirmations
-- go within a minute (12 §1). Messages queued before this have none, and are not counted. See
-- ADR-727 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.messages ADD COLUMN due_at timestamptz;
