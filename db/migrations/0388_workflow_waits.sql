-- 0388 · Workflows that wait
-- A workflow's run may wait, an hour to a week, before its next action (ADR-886): it stays
-- pending until then, and an app's action after it is tried for a day from when the wait was up,
-- not from when the run was made. Runs kept 30 days are cleared once finished, never mid-wait.
-- See ADR-886 in docs/architecture/13-decision-log.md.

ALTER TABLE apps.workflow_runs ADD COLUMN waited_until timestamptz;
