-- 0081 · Comments on an order's timeline
-- Staff and apps write on an order's timeline (ORD-02, ADR-128). A comment is its author's to
-- edit or delete, and may name the customer, so comments live apart from the timeline's events,
-- which stay append-only and never hold contact details; an erasure deletes them. The author is
-- a member of staff's account or an app's access token, neither of which this module owns.

CREATE TABLE orders.order_comments (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL,
  order_id    uuid        NOT NULL,
  message     text        NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  author_kind text        NOT NULL CHECK (author_kind IN ('app', 'staff')),
  author_id   uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  edited_at   timestamptz,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id) ON DELETE CASCADE
);

-- An order's comments, newest first, read beside its events for the timeline.
CREATE INDEX order_comments_order_idx ON orders.order_comments (shop_id, order_id, id);

SELECT platform.enable_tenant_isolation('orders.order_comments');
