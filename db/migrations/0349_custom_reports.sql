-- 0349 · Custom reports
-- Reports a shop saves of its own (ANL-06): the sales report broken down by day, week or month,
-- by product, by channel, or by where orders' last visits came from or their campaigns, with the
-- columns chosen in the order chosen, over a period that moves with the day it is run, such as
-- last month. Worked out from the orders when run, as the sales report is; only what to show is
-- kept. A scheduled export may send one, by the period that just ended, as a workbook. See
-- ADR-817 and ADR-818 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.custom_reports (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL,
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  breakdown   text        NOT NULL CHECK (breakdown IN ('day', 'week', 'month', 'product',
                                                        'source', 'visit_source', 'campaign')),
  -- The columns shown, in order; which a breakdown takes is the service's to check.
  columns     text[]      NOT NULL CHECK (cardinality(columns) BETWEEN 1 AND 20),
  period      text        NOT NULL CHECK (period IN ('today', 'yesterday', 'last_7_days',
                                                     'last_30_days', 'last_90_days', 'this_week',
                                                     'last_week', 'this_month', 'last_month',
                                                     'last_12_months', 'this_year')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.custom_reports');
