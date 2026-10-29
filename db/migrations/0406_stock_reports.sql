-- 0406 · Reports of stock
-- A report a shop saves of its own may be of stock (ANL-06): each tracked variant, what it has now
-- and what sold of it over the report's period, as the inventory report has them. See ADR-910 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.custom_reports DROP CONSTRAINT custom_reports_breakdown_check;
ALTER TABLE orders.custom_reports ADD CONSTRAINT custom_reports_breakdown_check
  CHECK (breakdown IN ('day', 'week', 'month', 'product', 'source', 'visit_source', 'campaign',
                       'customer', 'city', 'stock'));
