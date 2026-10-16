-- 0222 · Listings Hatti holds off sale
-- A rights owner's complaint that Hatti's people uphold takes the listings it names off sale
-- (TNS-04): each is made a draft and held, marked with the complaint's number, and may not go on
-- sale, nor a copy of it, until Hatti lets it go. See ADR-475 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE catalog.products
  ADD COLUMN held_by text CHECK (char_length(held_by) BETWEEN 1 AND 100);
