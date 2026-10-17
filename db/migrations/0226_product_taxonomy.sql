-- 0226 · Product taxonomy and condition
-- A product's standard category, from Google's product taxonomy as Hatti offers it, and whether
-- it is new, refurbished or used (CAT-18): what shopping feeds and ads ask of it. See ADR-483 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE catalog.products
  ADD COLUMN category text CHECK (length(category) BETWEEN 1 AND 255),
  ADD COLUMN condition text NOT NULL DEFAULT 'new'
    CHECK (condition IN ('new', 'refurbished', 'used'));
