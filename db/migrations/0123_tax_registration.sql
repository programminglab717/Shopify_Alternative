-- 0123 · The shop's tax registration (TAX-02)
-- The numbers FBR registered the shop under, which its invoices name: its NTN, seven digits and a
-- check digit, or a CNIC's thirteen for a sole trader; and its sales tax registration number
-- (STRN), thirteen digits, which makes its invoices sales tax invoices.
-- See ADR-190 in docs/architecture/13-decision-log.md.

ALTER TABLE tax.settings
  ADD COLUMN ntn  text CHECK (ntn ~ '^([0-9]{7}-[0-9]|[0-9]{5}-[0-9]{7}-[0-9])$'),
  ADD COLUMN strn text CHECK (strn ~ '^[0-9]{13}$');
