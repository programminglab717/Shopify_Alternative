-- 0132 · Asking a gateway what became of a payment
-- A payment started online whose customer never came back is asked after (PAY-01): the
-- gateway's status inquiry, as JazzCash has one, from a quarter of an hour after it began, at
-- most once an hour, for two days. A session the gateway says is paid is paid through the
-- inquiry. See ADR-208 in docs/architecture/13-decision-log.md.

ALTER TABLE payments.sessions
  ADD COLUMN inquired_at timestamptz,
  DROP CONSTRAINT sessions_paid_through_check,
  ADD CONSTRAINT sessions_paid_through_check
    CHECK (paid_through IN ('return', 'webhook', 'inquiry'));

-- The sessions still open, by when they began, for the sweep across shops that asks after them.
CREATE INDEX sessions_open ON payments.sessions (created_at) WHERE status = 'open';
