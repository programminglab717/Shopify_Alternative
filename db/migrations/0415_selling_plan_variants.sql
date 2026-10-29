-- 0415 · Selling plans for chosen variants (CAT-16)
-- A plan may be for chosen variants alone, fifty at most, rather than for its products of a tag or
-- all of them: a tea's large tin sold by subscription, its sample not. The product page offers it
-- on those variants, checkout prices it there alone, and an order's line on another variant is
-- bought once. See ADR-930 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.selling_plans
  ADD COLUMN variant_ids uuid[]
    CHECK (variant_ids IS NULL
           OR (cardinality(variant_ids) BETWEEN 1 AND 50 AND product_tag IS NULL));
