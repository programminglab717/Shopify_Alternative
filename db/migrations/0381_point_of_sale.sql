-- 0381 · Point of sale (POS-01, POS-02, POS-05, POS-07)
-- A shop's tills: each register sells from one of its locations, in cash sessions a member of
-- staff opens with a float and closes by counting the drawer, the Z report saying what the drawer
-- should hold. A sale at the till is not an order: a walk-in shopper gives no number or address,
-- and nothing is delivered. It takes its units off the location's shelf at once, is paid in
-- cash, by card on the shop's own terminal, by transfer or a wallet, and is kept with its lines and
-- its payments; a customer's number links it to them. A sale made while the till was offline
-- carries the till's own ID for it, so that sending it again records it once. Returns put units
-- back on the shelf and pay the shopper back from the drawer. See ADR-872 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE orders.pos_registers (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL,
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  -- Where it sells from. No foreign key: the location belongs to the inventory module.
  location_id uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.pos_registers');

CREATE UNIQUE INDEX pos_registers_name_key
  ON orders.pos_registers (shop_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE orders.pos_sessions (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL,
  register_id     uuid        NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  opened_by_kind  text        NOT NULL CHECK (opened_by_kind IN ('app', 'staff')),
  opened_by_id    uuid        NOT NULL,
  -- Cash in the drawer as the session opened.
  opening_float   bigint      NOT NULL CHECK (opening_float >= 0),
  closed_at       timestamptz,
  closed_by_kind  text        CHECK (closed_by_kind IN ('app', 'staff')),
  closed_by_id    uuid,
  -- What the drawer should hold as it closed, and what was counted in it.
  expected_cash   bigint,
  counted_cash    bigint      CHECK (counted_cash >= 0),
  closing_note    text        CHECK (length(closing_note) <= 500),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, register_id) REFERENCES orders.pos_registers (shop_id, id),
  CONSTRAINT pos_sessions_closed_check CHECK (
    (closed_at IS NULL) = (counted_cash IS NULL)
    AND (closed_at IS NULL) = (expected_cash IS NULL)
    AND (closed_at IS NULL) = (closed_by_id IS NULL)
  )
);

SELECT platform.enable_tenant_isolation('orders.pos_sessions');

-- One open session a register.
CREATE UNIQUE INDEX pos_sessions_open_key
  ON orders.pos_sessions (shop_id, register_id) WHERE closed_at IS NULL;

CREATE TABLE orders.pos_cash_movements (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL,
  session_id uuid        NOT NULL,
  -- Cash put in, as change from the bank, or taken out, as to pay a supplier or bank it.
  kind       text        NOT NULL CHECK (kind IN ('in', 'out')),
  amount     bigint      NOT NULL CHECK (amount > 0),
  note       text        NOT NULL CHECK (length(note) BETWEEN 1 AND 200),
  actor_kind text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  actor_id   uuid        NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, session_id) REFERENCES orders.pos_sessions (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.pos_cash_movements');

ALTER TABLE orders.counters ADD COLUMN next_pos_number integer NOT NULL DEFAULT 1;

CREATE TABLE orders.pos_sales (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL,
  -- #P1, #P2…, the shop's own run of till receipts.
  number       integer     NOT NULL CHECK (number > 0),
  -- The till's own ID for it, so that a sale sent again from an offline till is kept once.
  client_id    uuid        NOT NULL,
  register_id  uuid        NOT NULL,
  session_id   uuid        NOT NULL,
  location_id  uuid        NOT NULL,
  -- The customer whose number was given; none for a walk-in.
  customer_id  uuid,
  actor_kind   text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  actor_id     uuid        NOT NULL,
  currency     text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal     bigint      NOT NULL CHECK (subtotal >= 0),
  discount     bigint      NOT NULL CHECK (discount >= 0),
  -- The sales tax included in its prices.
  tax          bigint      NOT NULL CHECK (tax >= 0),
  total        bigint      NOT NULL CHECK (total >= 0),
  -- Cash handed back from what was tendered in cash.
  change_given bigint      NOT NULL DEFAULT 0 CHECK (change_given >= 0),
  returned     bigint      NOT NULL DEFAULT 0 CHECK (returned >= 0),
  note         text        NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  -- When the till sold it: earlier than it was kept, for a sale an offline till sent later.
  sold_at      timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT pos_sales_number_key UNIQUE (shop_id, number),
  CONSTRAINT pos_sales_client_key UNIQUE (shop_id, client_id),
  FOREIGN KEY (shop_id, session_id) REFERENCES orders.pos_sessions (shop_id, id),
  CONSTRAINT pos_sales_sums_check CHECK (discount <= subtotal AND total = subtotal - discount),
  CONSTRAINT pos_sales_returned_within_check CHECK (returned <= total)
);

SELECT platform.enable_tenant_isolation('orders.pos_sales');

CREATE INDEX pos_sales_recent ON orders.pos_sales (shop_id, sold_at DESC, id DESC);
CREATE INDEX pos_sales_session ON orders.pos_sales (shop_id, session_id);
CREATE INDEX pos_sales_customer ON orders.pos_sales (shop_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE TABLE orders.pos_sale_lines (
  shop_id       uuid    NOT NULL,
  id            uuid    NOT NULL,
  sale_id       uuid    NOT NULL,
  position      integer NOT NULL CHECK (position >= 1),
  -- As it was sold: no foreign key to the catalog, whose variant may be deleted later.
  variant_id    uuid    NOT NULL,
  product_id    uuid    NOT NULL,
  title         text    NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  variant_title text    NOT NULL,
  sku           text,
  quantity      integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  unit_price    bigint  NOT NULL CHECK (unit_price >= 0),
  -- Its share of the sale's discount, and what was paid for it.
  discount      bigint  NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total         bigint  NOT NULL CHECK (total >= 0),
  tax           bigint  NOT NULL DEFAULT 0 CHECK (tax >= 0),
  returned      integer NOT NULL DEFAULT 0 CHECK (returned >= 0 AND returned <= quantity),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT pos_sale_lines_position_key UNIQUE (shop_id, sale_id, position),
  FOREIGN KEY (shop_id, sale_id) REFERENCES orders.pos_sales (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.pos_sale_lines');

CREATE TABLE orders.pos_tenders (
  shop_id   uuid   NOT NULL,
  id        uuid   NOT NULL,
  sale_id   uuid   NOT NULL,
  -- Cash in the drawer; a card on the shop's own terminal; a bank transfer or Raast; a wallet,
  -- JazzCash or Easypaisa, to the shop's own account.
  method    text   NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'wallet')),
  amount    bigint NOT NULL CHECK (amount > 0),
  -- The terminal's or the transfer's reference, as staff typed it.
  reference text   CHECK (length(reference) <= 100),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, sale_id) REFERENCES orders.pos_sales (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.pos_tenders');

CREATE TABLE orders.pos_returns (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL,
  sale_id     uuid        NOT NULL,
  -- The session whose drawer paid it back.
  session_id  uuid        NOT NULL,
  amount      bigint      NOT NULL CHECK (amount >= 0),
  method      text        NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'wallet')),
  restocked   boolean     NOT NULL,
  reason      text        CHECK (length(reason) <= 200),
  actor_kind  text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  actor_id    uuid        NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, sale_id) REFERENCES orders.pos_sales (shop_id, id),
  FOREIGN KEY (shop_id, session_id) REFERENCES orders.pos_sessions (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.pos_returns');

CREATE TABLE orders.pos_return_lines (
  shop_id      uuid    NOT NULL,
  id           uuid    NOT NULL,
  return_id    uuid    NOT NULL,
  sale_line_id uuid    NOT NULL,
  quantity     integer NOT NULL CHECK (quantity >= 1),
  amount       bigint  NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, return_id) REFERENCES orders.pos_returns (shop_id, id),
  FOREIGN KEY (shop_id, sale_line_id) REFERENCES orders.pos_sale_lines (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.pos_return_lines');
