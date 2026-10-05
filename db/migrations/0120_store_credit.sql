-- 0120 · Store credit (ORD-09)
-- What a shop owes a customer to spend with it, in place of money given back: credited by a
-- refund given as store credit, or by hand; debited by hand, or by the orders it pays for; and
-- ended where a credit says when it expires. One account for each customer and currency, as
-- Shopify's StoreCreditAccount. Its balance is what its credits have left that has not expired,
-- worked out when asked, never kept apart from them.
-- See ADR-184 in docs/architecture/13-decision-log.md.

CREATE TABLE customers.store_credit_accounts (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL,
  customer_id uuid        NOT NULL,
  currency    text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT store_credit_accounts_owner_key UNIQUE (shop_id, customer_id, currency),
  -- An erased customer's account goes with them, once nothing is left on it; a merged one's
  -- moves to the customer they were merged into first.
  FOREIGN KEY (shop_id, customer_id)
    REFERENCES customers.customers (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('customers.store_credit_accounts');

-- Every change of an account's balance, in the order it was made: each is written holding the
-- account's lock, at clock_timestamp(), so that one waiting for the lock comes after the one
-- holding it.
CREATE TABLE customers.store_credit_transactions (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL,
  account_id uuid        NOT NULL,
  kind       text        NOT NULL
             CHECK (kind IN ('credit', 'debit', 'debit_revert', 'expiration')),
  -- Why, as Shopify's StoreCreditSystemEvent: null for an expiration, which its kind says.
  event      text
             CHECK (event IN ('adjustment', 'order_refund', 'order_payment', 'order_cancellation')),
  -- Minor units, always more than 0: the kind says which way it went.
  amount     bigint      NOT NULL CHECK (amount > 0),
  -- A credit's: when it expires (null: never), and what is left of it to spend.
  expires_at timestamptz,
  remaining  bigint,
  -- The order it was for: refunded to store credit, paid with it, or cancelled after.
  order_id   uuid,
  refund_id  uuid,
  -- The debit a revert gives back, or the credit an expiration ends.
  source_id  uuid,
  note       text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  actor_kind text        NOT NULL CHECK (actor_kind IN ('app', 'staff', 'system')),
  actor_id   uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, account_id)
    REFERENCES customers.store_credit_accounts (shop_id, id) ON DELETE CASCADE,
  CONSTRAINT store_credit_transactions_remaining_check
    CHECK ((kind = 'credit') = (remaining IS NOT NULL) AND remaining BETWEEN 0 AND amount),
  CONSTRAINT store_credit_transactions_expiry_check
    CHECK (kind = 'credit' OR expires_at IS NULL),
  CONSTRAINT store_credit_transactions_why_check
    CHECK ((kind = 'expiration') = (event IS NULL)),
  CONSTRAINT store_credit_transactions_source_check
    CHECK ((kind IN ('debit_revert', 'expiration')) = (source_id IS NOT NULL)),
  CONSTRAINT store_credit_transactions_actor_check
    CHECK ((actor_kind = 'system') = (actor_id IS NULL))
);

CREATE INDEX store_credit_transactions_account_idx
  ON customers.store_credit_transactions (shop_id, account_id, created_at, id);
-- Credits that expire with something left: what the worker's sweep looks for.
CREATE INDEX store_credit_transactions_expiring_idx
  ON customers.store_credit_transactions (expires_at)
  WHERE kind = 'credit' AND remaining > 0 AND expires_at IS NOT NULL;
CREATE INDEX store_credit_transactions_order_idx
  ON customers.store_credit_transactions (shop_id, order_id)
  WHERE order_id IS NOT NULL;
-- A debit is given back once at most.
CREATE UNIQUE INDEX store_credit_transactions_revert_key
  ON customers.store_credit_transactions (shop_id, source_id)
  WHERE kind = 'debit_revert';

SELECT platform.enable_tenant_isolation('customers.store_credit_transactions');

-- What each debit took from which credit, the soonest to expire first, so that a debit given
-- back goes back to the credits it came from, which expire as they would have.
CREATE TABLE customers.store_credit_allocations (
  shop_id   uuid   NOT NULL,
  debit_id  uuid   NOT NULL,
  credit_id uuid   NOT NULL,
  amount    bigint NOT NULL CHECK (amount > 0),
  PRIMARY KEY (shop_id, debit_id, credit_id),
  FOREIGN KEY (shop_id, debit_id)
    REFERENCES customers.store_credit_transactions (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, credit_id)
    REFERENCES customers.store_credit_transactions (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX store_credit_allocations_credit_idx
  ON customers.store_credit_allocations (shop_id, credit_id);

SELECT platform.enable_tenant_isolation('customers.store_credit_allocations');

-- The ledger keeps what happened. Request code adds to it, spends credits (`remaining`) and moves
-- a merged customer's transactions (`account_id`); it rewrites and deletes nothing else. An
-- erasure takes an emptied account's ledger with the customer, through the foreign keys.
REVOKE UPDATE, DELETE ON customers.store_credit_transactions FROM hatti_app_role;
GRANT UPDATE (remaining, account_id) ON customers.store_credit_transactions TO hatti_app_role;
REVOKE UPDATE, DELETE ON customers.store_credit_allocations FROM hatti_app_role;

-- A refund given as store credit: no money moved, the customer's account was credited with it.
ALTER TABLE orders.refunds
  DROP CONSTRAINT refunds_method_check,
  ADD CONSTRAINT refunds_method_check
    CHECK (method IN ('bank_transfer', 'mobile_wallet', 'cash', 'other', 'exchange', 'online',
                      'store_credit'));
