-- 0220 · Prohibited-items screening
-- A product whose words name goods Hatti's Acceptable Use Policy forbids (TNS-03) is kept off
-- sale: it may be a draft, never active. Hatti's people may clear one found by mistake, for its
-- words as they are: the digest of those words is kept, and screening finds it again once they
-- change. See ADR-473 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.products
  ADD COLUMN screening_cleared text CHECK (screening_cleared ~ '^[0-9a-f]{64}$');
