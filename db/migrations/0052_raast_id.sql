-- 0052 · The shop's Raast ID
-- Beside its IBAN, a shop's account takes the mobile number its bank registered for Raast, which
-- customers' banking apps pay to (PAY-02); the order keeps it with the account its customer was
-- told, as `raastId` in its bank_account. See ADR-082 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.bank_transfer_settings
  -- In E.164: +923001234567. Only with an account.
  ADD COLUMN raast_id text CHECK (raast_id ~ '^\+923[0-9]{9}$'),
  ADD CONSTRAINT bank_transfer_settings_raast_check CHECK (raast_id IS NULL OR iban IS NOT NULL);
