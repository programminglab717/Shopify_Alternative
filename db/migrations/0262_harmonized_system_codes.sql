-- 0262 · HS codes
-- A variant's harmonized system code, kept with its inventory item as Shopify keeps it (CAT-19):
-- the tariff code customs and FBR know its goods by. FBR is sent an item's own PCT code, its 8
-- digits, where it has one, rather than the shop's one for everything. See ADR-557 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE inventory.items
  -- Its digits alone, 6 to 13 as Shopify takes them; null for none.
  ADD COLUMN harmonized_system_code text CHECK (harmonized_system_code ~ '^[0-9]{6,13}$');
