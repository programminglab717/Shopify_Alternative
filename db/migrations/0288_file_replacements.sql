-- 0288 · Files replaced
-- A file's upload may replace what it holds, keeping its ID (ADR-647): it is kept where its
-- upload was staged, under the shop's own prefix still, no longer under its own ID's folder. See
-- ADR-647 in docs/architecture/13-decision-log.md.

ALTER TABLE files.files DROP CONSTRAINT files_check;
ALTER TABLE files.files ADD CONSTRAINT files_key_check
  CHECK (key LIKE 'shops/' || shop_id || '/files/%/%');
