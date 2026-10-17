-- 0231 · Invoice series (TAX-05)
-- A registered seller's invoices are numbered in a series of their own, with no number skipped
-- or used twice, counted afresh each tax year, which in Pakistan starts on 1 July. An order's
-- invoice takes the next number the first time it is printed, and keeps it. See ADR-495 in
-- docs/architecture/13-decision-log.md.

-- The last number given in each of a shop's series, by the year its tax year starts in. Taken
-- under the row's lock in the transaction that gives it, so a rolled back invoice gives its
-- number back.
CREATE TABLE orders.document_counters (
  shop_id     uuid    NOT NULL,
  kind        text    NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  tax_year    integer NOT NULL CHECK (tax_year BETWEEN 2000 AND 2999),
  last_number integer NOT NULL CHECK (last_number > 0),
  PRIMARY KEY (shop_id, kind, tax_year)
);

-- An order's invoice: its number in its tax year's series, and when it was issued.
CREATE TABLE orders.order_invoices (
  shop_id   uuid        NOT NULL,
  order_id  uuid        NOT NULL,
  tax_year  integer     NOT NULL CHECK (tax_year BETWEEN 2000 AND 2999),
  number    integer     NOT NULL CHECK (number > 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, order_id),
  UNIQUE (shop_id, tax_year, number),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('orders.document_counters');
SELECT platform.enable_tenant_isolation('orders.order_invoices');
