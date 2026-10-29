-- 0402 · Scheduled workflows
-- Workflows that run on days of the week at an hour of the shop's own time (MKT-04), reading the
-- shop's queues then: orders to confirm, review, pack and book, and variants low or out. Each slot
-- runs once, its run's event a name made of the workflow and the slot. See ADR-906 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE apps.workflows DROP CONSTRAINT workflows_trigger_check;
ALTER TABLE apps.workflows ADD CONSTRAINT workflows_trigger_check
  CHECK (trigger IN ('order_created', 'order_confirmed', 'order_paid', 'order_cancelled',
                     'order_delivered', 'order_returned', 'customer_created', 'stock_low',
                     'stock_out', 'scheduled', 'app'));

-- {days: [1..7], Monday 1, hour: 0..23}, for a scheduled workflow alone.
ALTER TABLE apps.workflows ADD COLUMN schedule jsonb
  CHECK ((trigger = 'scheduled') = (schedule IS NOT NULL));
