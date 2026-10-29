-- 0409 · Receipts read as they arrive
-- A shop may have each receipt its customers send for their transfers read by the AI as it
-- arrives (PAY-08), rather than when staff ask: each reading spends an AI credit as asking does.
-- Kept with the shop's bank transfer settings, and audited with them. See ADR-915 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.bank_transfer_settings
  ADD COLUMN read_receipts boolean NOT NULL DEFAULT false;
