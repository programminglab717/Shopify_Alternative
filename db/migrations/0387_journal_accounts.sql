-- 0387 · The accounts a shop's journal posts to
-- A shop's sales as a journal of debits and credits for its books (ANL-10), an entry a day: the
-- accounts it posts to are named and numbered here as the shop's own books know them, for Xero
-- (by code), QuickBooks and Tally (by name). Accounts not named here are posted to by Hatti's
-- usual names. See ADR-885 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.journal_accounts (
  shop_id    uuid        NOT NULL,
  account    text        NOT NULL CHECK (account IN (
    'receivable', 'sales', 'discounts', 'returns', 'shipping', 'fees', 'sales_tax',
    'cost_of_goods', 'inventory', 'bank', 'courier_charges', 'couriers', 'write_offs', 'claims')),
  code       text        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 20),
  name       text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, account)
);

SELECT platform.enable_tenant_isolation('orders.journal_accounts');
