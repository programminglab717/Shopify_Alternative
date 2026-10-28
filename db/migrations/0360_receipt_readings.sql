-- 0360 · Receipts for transfers, read by the AI (PAY-08)
-- Staff ask the AI to read a receipt a customer sent for their transfer (ADR-080): what it says,
-- how much was sent, when, its reference, from whom and to whom; Hatti checks that against what
-- the order waited for then, the account its customer was told, and the references of the shop's
-- other receipts, and staff confirm the payment themselves. A reading spends an AI credit, as
-- drafts do. See ADR-845 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.transfer_receipts
  -- When it was read, and what came of it: read, not a receipt at all, or the AI's failure.
  ADD COLUMN read_at           timestamptz,
  ADD COLUMN read_outcome      text
                               CHECK (read_outcome IN ('read', 'not_a_receipt', 'failed')),
  -- What it says, as the AI read it; null for what it does not show.
  ADD COLUMN read_amount       bigint CHECK (read_amount > 0),
  ADD COLUMN read_paid_on      date,
  ADD COLUMN read_reference    text CHECK (char_length(read_reference) <= 64),
  ADD COLUMN read_sender_name  text CHECK (char_length(read_sender_name) <= 100),
  ADD COLUMN read_sender_bank  text CHECK (char_length(read_sender_bank) <= 60),
  ADD COLUMN read_recipient_name    text CHECK (char_length(read_recipient_name) <= 100),
  ADD COLUMN read_recipient_account text CHECK (char_length(read_recipient_account) <= 40),
  -- What its order waited for by transfer when it was read, minor units: what the amount is
  -- checked against.
  ADD COLUMN read_owed         bigint CHECK (read_owed >= 0),
  -- Its reference, as compared: letters and digits alone, upper case.
  ADD COLUMN read_reference_key text,
  ADD COLUMN read_input_tokens  integer NOT NULL DEFAULT 0 CHECK (read_input_tokens >= 0),
  ADD COLUMN read_output_tokens integer NOT NULL DEFAULT 0 CHECK (read_output_tokens >= 0),
  ADD CONSTRAINT transfer_receipts_read
    CHECK ((read_at IS NULL) = (read_outcome IS NULL));

-- Another receipt of the shop's with the same reference: the same transfer sent twice.
CREATE INDEX transfer_receipts_by_reference
    ON orders.transfer_receipts (shop_id, read_reference_key)
 WHERE read_reference_key IS NOT NULL;

ALTER TABLE billing.ai_credit_uses DROP CONSTRAINT ai_credit_uses_use_check;
ALTER TABLE billing.ai_credit_uses
  ADD CONSTRAINT ai_credit_uses_use_check
  CHECK (use IN ('product_copy', 'translation', 'article', 'report_question',
                 'transfer_receipt'));
