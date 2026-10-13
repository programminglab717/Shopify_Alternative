-- 0191 · Size charts (CAT-10)
-- The shop's size charts: a table of measurements, a row for each size, in inches or
-- centimetres, which shoppers can read in either. A product shows the one the shop gives it.
-- See ADR-406 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.size_charts (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- The unit its measurements are written in: 'in' or 'cm'.
  unit       text        NOT NULL CHECK (unit IN ('in', 'cm')),
  -- What is measured, in order: ["Chest", "Length", "Shoulder"].
  columns    jsonb       NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  -- A row for each size, in order: [{"size": "M", "values": [40, 42, null]}], a value for each
  -- column, null where none is given.
  rows       jsonb       NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  -- How to measure, or what else shoppers should know.
  note       text        CHECK (length(note) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, name)
);
SELECT platform.enable_tenant_isolation('catalog.size_charts');

-- The chart each product shows, at most one.
CREATE TABLE catalog.product_size_charts (
  shop_id       uuid NOT NULL,
  product_id    uuid NOT NULL,
  size_chart_id uuid NOT NULL,
  PRIMARY KEY (shop_id, product_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, size_chart_id) REFERENCES catalog.size_charts (shop_id, id)
    ON DELETE CASCADE
);
CREATE INDEX product_size_charts_chart_idx ON catalog.product_size_charts (shop_id, size_chart_id);
SELECT platform.enable_tenant_isolation('catalog.product_size_charts');
