-- Filer-status checks (TAX-08, ADR-837): when the shop last said whether it is on FBR's Active
-- Taxpayers List, so that Hatti asks it to check again once FBR publishes a new list each
-- 1 March, and whenever it has never said.
ALTER TABLE tax.settings ADD COLUMN filer_checked_at timestamptz;
