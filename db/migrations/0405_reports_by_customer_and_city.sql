-- 0405 · Reports by customer and by city
-- Sales reports, and the reports a shop saves of its own, break sales down by customer and by the
-- city orders went to too (ANL-06, ANL-08). See ADR-909 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.custom_reports DROP CONSTRAINT custom_reports_breakdown_check;
ALTER TABLE orders.custom_reports ADD CONSTRAINT custom_reports_breakdown_check
  CHECK (breakdown IN ('day', 'week', 'month', 'product', 'source', 'visit_source', 'campaign',
                       'customer', 'city'));
