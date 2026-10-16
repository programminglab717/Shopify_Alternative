-- 0207 · Gift cards (CAT-12, PAY-13)
-- A code worth an amount at the shop, as Shopify's GiftCard: whoever has the code spends it, on
-- orders, until its balance is used up, it expires or the shop deactivates it. The shop keeps a
-- digest of the code alone, and its last four characters to tell it by. Its balance is kept on
-- it, changed only holding its lock, with a ledger of every change.
-- See ADR-448 in docs/architecture/13-decision-log.md.

CREATE TABLE customers.gift_cards (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL,
  -- SHA-256 of the code as typed, without spaces or dashes, in capitals.
  code_hash       bytea       NOT NULL CHECK (length(code_hash) = 32),
  last_characters text        NOT NULL CHECK (last_characters ~ '^[A-Z0-9]{4}$'),
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Minor units: what it was issued for, and what it has left.
  initial_value   bigint      NOT NULL CHECK (initial_value > 0),
  balance         bigint      NOT NULL CHECK (balance >= 0),
  -- The last day it can be spent, in the shop's time zone; null for never.
  expires_on      date,
  -- Who it was given to, if the shop says; the code is spent by whoever has it.
  customer_id     uuid,
  note            text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  -- Deactivated for good, as Shopify's.
  deactivated_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT gift_cards_code_key UNIQUE (shop_id, code_hash),
  -- An erased customer's cards stay the shop's to honour: only who they were given to goes.
  FOREIGN KEY (shop_id, customer_id)
    REFERENCES customers.customers (shop_id, id) ON DELETE SET NULL (customer_id)
);

CREATE INDEX gift_cards_created_idx ON customers.gift_cards (shop_id, created_at DESC, id DESC);
CREATE INDEX gift_cards_customer_idx ON customers.gift_cards (shop_id, customer_id)
  WHERE customer_id IS NOT NULL;

SELECT platform.enable_tenant_isolation('customers.gift_cards');

-- Every change of a card's balance, in the order it was made, each written holding the card's
-- lock: its issue, credits and debits by hand, the orders it paid, and those given back.
CREATE TABLE customers.gift_card_transactions (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL,
  gift_card_id uuid        NOT NULL,
  kind         text        NOT NULL
               CHECK (kind IN ('issue', 'credit', 'debit', 'debit_revert')),
  -- Minor units, always more than 0: the kind says which way it went.
  amount       bigint      NOT NULL CHECK (amount > 0),
  balance_after bigint     NOT NULL CHECK (balance_after >= 0),
  -- The order a debit paid, or whose cancellation gave it back.
  order_id     uuid,
  -- The debit a revert gives back.
  source_id    uuid,
  note         text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  actor_kind   text        NOT NULL CHECK (actor_kind IN ('app', 'staff', 'system')),
  actor_id     uuid,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, gift_card_id)
    REFERENCES customers.gift_cards (shop_id, id) ON DELETE CASCADE,
  CONSTRAINT gift_card_transactions_source_check
    CHECK ((kind = 'debit_revert') = (source_id IS NOT NULL)),
  CONSTRAINT gift_card_transactions_actor_check
    CHECK ((actor_kind = 'system') = (actor_id IS NULL))
);

CREATE INDEX gift_card_transactions_card_idx
  ON customers.gift_card_transactions (shop_id, gift_card_id, created_at, id);
CREATE INDEX gift_card_transactions_order_idx
  ON customers.gift_card_transactions (shop_id, order_id)
  WHERE order_id IS NOT NULL;
-- A debit is given back once at most.
CREATE UNIQUE INDEX gift_card_transactions_revert_key
  ON customers.gift_card_transactions (shop_id, source_id)
  WHERE kind = 'debit_revert';

SELECT platform.enable_tenant_isolation('customers.gift_card_transactions');

-- The ledger keeps what happened: request code adds to it, and rewrites and deletes nothing.
REVOKE UPDATE, DELETE ON customers.gift_card_transactions FROM hatti_app_role;
-- Cards are not deleted, only deactivated; their codes never change.
REVOKE DELETE ON customers.gift_cards FROM hatti_app_role;
REVOKE UPDATE ON customers.gift_cards FROM hatti_app_role;
GRANT UPDATE (balance, expires_on, customer_id, note, deactivated_at, updated_at)
  ON customers.gift_cards TO hatti_app_role;
