-- 0391 · How long a supplier takes to deliver
-- The days from ordering to the goods arriving, as the shop knows its supplier (INV-08): a
-- reorder counts on what sells meanwhile, and a purchase order expects its goods that much later.
-- Null where the shop has not said. See ADR-892 in docs/architecture/13-decision-log.md.

ALTER TABLE inventory.suppliers
  ADD COLUMN lead_time_days smallint CHECK (lead_time_days BETWEEN 0 AND 180);
