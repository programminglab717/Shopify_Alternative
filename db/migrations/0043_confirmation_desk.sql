-- 0043 · The Confirmation Desk's queue
-- Agents call customers to confirm their cash-on-delivery orders (COD-04). An order waiting to be
-- confirmed is due for a call from when it is placed, and again when a call goes unanswered or
-- the customer asks to be called back; an agent takes the most urgent order due, which is theirs
-- for a few minutes, so that no two agents call the same customer. See ADR-073 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders
  -- Calls the customer did not answer since the order was placed.
  ADD COLUMN unanswered_calls smallint NOT NULL DEFAULT 0 CHECK (unanswered_calls >= 0),
  -- When it is due for a call again; null: since it was placed.
  ADD COLUMN confirmation_due_at timestamptz,
  -- The agent, or app, calling the customer now, until when. The queue's, not the order's: taking
  -- an order changes neither its version nor its timeline.
  ADD COLUMN claimed_by_kind text CHECK (claimed_by_kind IN ('app', 'staff')),
  ADD COLUMN claimed_by uuid,
  ADD COLUMN claimed_until timestamptz,
  ADD CONSTRAINT orders_claim_check
      CHECK ((claimed_by IS NULL) = (claimed_until IS NULL)
             AND (claimed_by IS NULL) = (claimed_by_kind IS NULL));

-- The queue: orders waiting for their customers to confirm them, few beside the rest.
CREATE INDEX orders_confirmation_queue_idx
  ON orders.orders (shop_id, created_at)
  WHERE stage = 'needs_confirmation';

-- Each call made to confirm an order, and how it went. Its note may name the customer's plans, and
-- is cleared with their data.
CREATE TABLE orders.confirmation_calls (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL,
  order_id     uuid        NOT NULL,
  outcome      text        NOT NULL CHECK (outcome IN ('no_answer', 'call_back', 'wrong_number')),
  call_back_at timestamptz,
  note         text        NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  actor_kind   text        NOT NULL CHECK (actor_kind IN ('app', 'staff', 'system')),
  actor_id     uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id) ON DELETE CASCADE,
  CONSTRAINT confirmation_calls_call_back_check
    CHECK (outcome <> 'call_back' OR call_back_at IS NOT NULL)
);

CREATE INDEX confirmation_calls_order_idx ON orders.confirmation_calls (shop_id, order_id, id);

SELECT platform.enable_tenant_isolation('orders.confirmation_calls');
REVOKE DELETE ON orders.confirmation_calls FROM hatti_app_role;
