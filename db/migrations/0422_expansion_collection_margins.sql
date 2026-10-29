-- 0422 · An expansion store's margin by collection (CH-11)
-- Its copied prices may be put a different percent over its rate for the products of a
-- collection, freight dearer for furniture than for scarves: an ordered list, the first of the
-- product's collections in it giving its margin, the store's own margin for the rest. Ten at
-- most. See ADR-948 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.expansion_stores
  ADD COLUMN collection_margins jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(collection_margins) = 'array' AND jsonb_array_length(collection_margins) <= 10);
