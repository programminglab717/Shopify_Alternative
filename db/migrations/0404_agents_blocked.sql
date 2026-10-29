-- 0404 · Keeping AI agents out
-- A shop that does not want AI shopping agents buying for shoppers keeps them out (OS-23): its
-- UCP profile and store MCP endpoint answer as if it had none. See ADR-908 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  ADD COLUMN agents_blocked boolean NOT NULL DEFAULT false;
