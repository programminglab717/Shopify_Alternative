-- 0044 · Bank transfer
-- A shop that gives its bank account offers bank transfer beside cash on delivery (PAY-02). An
-- order paid by bank transfer is placed unpaid and waits at the `awaiting_payment` stage until
-- staff see the money and mark it paid; paying is its customer's say-so, so it needs no call to
-- confirm it. The order keeps the account its customer was told to pay into, as it was then. See
-- ADR-074 in docs/architecture/13-decision-log.md.

-- The shop's account, one a shop. Checkout offers bank transfer while it is enabled; staff may
-- place bank-transfer orders while it is not.
CREATE TABLE orders.bank_transfer_settings (
  shop_id       uuid        PRIMARY KEY,
  enabled       boolean     NOT NULL DEFAULT false,
  -- The account's title, as its bank has it: whose account customers are paying into.
  account_title text        CHECK (length(account_title) BETWEEN 1 AND 100),
  bank_name     text        CHECK (length(bank_name) BETWEEN 1 AND 100),
  -- A Pakistani IBAN, unspaced: PK, two check digits, the bank's four letters, 16 digits.
  iban          text        CHECK (iban ~ '^PK[0-9]{2}[A-Z]{4}[0-9]{16}$'),
  -- What customers are told besides, such as where to send the receipt.
  instructions  text        NOT NULL DEFAULT '' CHECK (length(instructions) <= 500),
  version       integer     NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_transfer_settings_account_check
    CHECK ((account_title IS NULL) = (iban IS NULL) AND (bank_name IS NULL) = (iban IS NULL)),
  CONSTRAINT bank_transfer_settings_enabled_check CHECK (NOT enabled OR iban IS NOT NULL)
);

SELECT platform.enable_tenant_isolation('orders.bank_transfer_settings');

ALTER TABLE orders.orders DROP CONSTRAINT orders_payment_method_check;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_payment_method_check
      CHECK (payment_method IN ('cash_on_delivery', 'prepaid', 'bank_transfer'));

-- The account a bank-transfer order's customer was told to pay into: {title, bankName, iban,
-- instructions}. Null when the shop had none, as for an order staff took in a chat.
ALTER TABLE orders.orders ADD COLUMN bank_account jsonb;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_bank_account_check
      CHECK (bank_account IS NULL OR (payment_method = 'bank_transfer'
                                      AND jsonb_typeof(bank_account) = 'object'));

ALTER TABLE orders.orders DROP CONSTRAINT orders_stage_check;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_stage_check
      CHECK (stage IN ('needs_confirmation', 'needs_review', 'awaiting_payment', 'to_pack',
                       'to_book', 'partially_fulfilled', 'in_transit', 'returning', 'delivered',
                       'returned', 'lost', 'completed', 'cancelled'));

-- Drafts taken in chats may be paid by transfer too; like a prepaid draft's, theirs is no
-- advance, and its link confirms cash on delivery alone.
ALTER TABLE orders.draft_orders DROP CONSTRAINT draft_orders_payment_method_check;
ALTER TABLE orders.draft_orders
  ADD CONSTRAINT draft_orders_payment_method_check
      CHECK (payment_method IN ('cash_on_delivery', 'prepaid', 'bank_transfer'));
