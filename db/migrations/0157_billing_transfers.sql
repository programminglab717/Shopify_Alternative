-- 0157 · Paying Hatti by transfer
-- A shop pays Hatti's invoice by bank transfer or Raast into Hatti's own account and says so with
-- the transfer's reference; Hatti's people find it in Hatti's account and confirm it, which pays
-- the invoice as a gateway's payment does, or refuse it, saying why (BIL-01). See ADR-254 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE billing.payments
  -- The bank's or Raast's reference for the transfer, as the shop's owner gave it.
  ADD COLUMN transfer_reference text CHECK (char_length(transfer_reference) BETWEEN 4 AND 64),
  -- Who among Hatti's people confirmed or refused it.
  ADD COLUMN checked_by text CHECK (char_length(checked_by) BETWEEN 1 AND 200),
  ADD CONSTRAINT payments_transfer_check
    CHECK ((gateway = 'bank_transfer') = (transfer_reference IS NOT NULL));

-- The transfers waiting for Hatti's people, the oldest first, across shops.
CREATE INDEX payments_transfers_waiting ON billing.payments (created_at)
  WHERE gateway = 'bank_transfer' AND status = 'open';

-- A transfer is said once: a reference refused may be given again.
CREATE UNIQUE INDEX payments_transfer_reference
  ON billing.payments (shop_id, lower(transfer_reference))
  WHERE transfer_reference IS NOT NULL AND status <> 'failed';
