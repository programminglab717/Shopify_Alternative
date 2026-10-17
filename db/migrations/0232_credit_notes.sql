-- 0232 · Credit notes (TAX-05)
-- Money refunded on an order whose invoice was issued goes on a credit note in a series of its
-- own, numbered as invoices are (0231): from 1 each tax year, with no number skipped or given
-- twice. See ADR-496 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.refund_credit_notes (
  shop_id   uuid        NOT NULL,
  refund_id uuid        NOT NULL,
  order_id  uuid        NOT NULL,
  tax_year  integer     NOT NULL CHECK (tax_year BETWEEN 2000 AND 2999),
  number    integer     NOT NULL CHECK (number > 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, refund_id),
  UNIQUE (shop_id, tax_year, number),
  FOREIGN KEY (shop_id, refund_id) REFERENCES orders.refunds (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.order_invoices (shop_id, order_id)
    ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('orders.refund_credit_notes');
