-- 0217 · A shop's return window
-- What a shop says of returns besides its refund policy's words (OS-11): how many days after
-- delivery it takes items back, none at all, or nothing said; and whether only for an exchange.
-- Its product pages say it, and its products' structured data gives it as a return policy. See
-- ADR-468 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  -- Days after delivery it takes items back: 0 for no returns; null for nothing said.
  ADD COLUMN return_days smallint CHECK (return_days BETWEEN 0 AND 90),
  -- Whether those it takes back are exchanged only, never refunded.
  ADD COLUMN return_exchanges_only boolean NOT NULL DEFAULT false;
