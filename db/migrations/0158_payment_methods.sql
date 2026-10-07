-- 0158 · How a payment online was made
-- A gateway's return says how its customer paid, as JazzCash's says by card, from a JazzCash
-- wallet or with a voucher paid at a shop; the payment keeps it, as JazzCash gives each back
-- through a refund of its own (PAY-06). See ADR-255 in docs/architecture/13-decision-log.md.

ALTER TABLE payments.sessions
  -- As the gateway names it, such as JazzCash's MWALLET, MPAY or OTC; null where it says none.
  ADD COLUMN method text CHECK (method ~ '^[A-Za-z0-9_]{1,30}$');
