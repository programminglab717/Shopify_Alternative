-- 0396 · Orders split among locations (INV-10, SHP-09)
-- A shop may have an order paid on delivery that no one location has all of split among those
-- that do, each part an order of its own shipped from its location (ADR-898). Off until the shop
-- turns it on.
-- See ADR-898 in docs/architecture/13-decision-log.md.

ALTER TABLE inventory.settings ADD COLUMN split_orders boolean NOT NULL DEFAULT false;
