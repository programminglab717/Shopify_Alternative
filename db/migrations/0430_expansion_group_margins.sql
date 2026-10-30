-- 0430 · An expansion store's margin by product type or vendor (CH-11)
-- A shop's products of one type, or from one vendor, may be put a margin of their own over an
-- expansion store's rate: the furniture dearer to ship than the cushions, a vendor's goods dearer
-- to bring in. A product's own margin (ADR-960) and its collection's (ADR-948) come first; the
-- store's for the rest. Twenty at most. See ADR-971 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.expansion_stores
  ADD COLUMN group_margins jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(group_margins) = 'array' AND jsonb_array_length(group_margins) <= 20);
