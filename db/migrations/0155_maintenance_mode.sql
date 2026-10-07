-- 0155 · Maintenance mode
-- An open shop can pause its storefront for a while, for a stock-take, a move or the days its
-- couriers stop for Eid: shoppers see a page saying it is back soon, search engines are told to
-- come back later rather than forget its pages, and checkout takes no orders, until its staff open
-- it again or the time they set comes (OS-15). See ADR-252 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  -- Whether the storefront is paused.
  ADD COLUMN maintenance_enabled boolean     NOT NULL DEFAULT false,
  -- What the page tells shoppers, as the shop typed it; empty for the platform's words.
  ADD COLUMN maintenance_message text        NOT NULL DEFAULT ''
                                             CHECK (length(maintenance_message) <= 1000),
  -- When it opens again by itself; null until its staff open it.
  ADD COLUMN maintenance_until   timestamptz;
