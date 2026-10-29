-- 0401 · Workflows on stock
-- Workflows a variant's stock starts (MKT-04): when it falls to the shop's low-stock line, and when
-- it runs out, as the shop's low-stock alert tells (ADR-157). See ADR-905 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE apps.workflows DROP CONSTRAINT workflows_trigger_check;
ALTER TABLE apps.workflows ADD CONSTRAINT workflows_trigger_check
  CHECK (trigger IN ('order_created', 'order_confirmed', 'order_paid', 'order_cancelled',
                     'order_delivered', 'order_returned', 'customer_created', 'stock_low',
                     'stock_out', 'app'));
