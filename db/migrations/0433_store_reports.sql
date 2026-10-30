-- 0433 · Reports of the owner's stores
-- A report a shop saves of its own may be of this shop and the owner's expansion stores (ANL-06,
-- CH-11): each one's orders and total sales in this shop's currency over the report's period, as
-- the stores' page has them. Run by the owner alone. See ADR-985 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.custom_reports DROP CONSTRAINT custom_reports_breakdown_check;
ALTER TABLE orders.custom_reports ADD CONSTRAINT custom_reports_breakdown_check
  CHECK (breakdown IN ('day', 'week', 'month', 'product', 'source', 'visit_source', 'campaign',
                       'customer', 'city', 'stock', 'stores'));
