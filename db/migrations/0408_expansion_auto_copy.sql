-- 0408 · Expansion stores kept in step
-- An owner may have a shop's products copied to an expansion store as they change, rather than
-- when asked (CH-11): the worker copies once the shop's products have been left alone a while,
-- and at most once an hour. A copy that failed is kept with why, and tried again an hour on. See
-- ADR-913 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.expansion_stores
  ADD COLUMN auto_copy  boolean     NOT NULL DEFAULT false,
  ADD COLUMN failed_at  timestamptz,
  ADD COLUMN copy_error text CHECK (char_length(copy_error) <= 500);
