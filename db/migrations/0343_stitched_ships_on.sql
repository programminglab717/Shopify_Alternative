-- 0343 · A stitched line's day to ship by
-- A line sold stitched to the shopper's measurements (CAT-09) keeps the day it was promised to
-- ship by: the day it was sold in Pakistan, or its pre-order's day if later, and the days its
-- stitching takes. See ADR-803 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.lines ADD COLUMN stitched_ships_on date;
