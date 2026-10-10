-- 0168 · Purchase orders
-- The shop's suppliers, and what it orders from them for a location: each line a variant and how
-- many, with what one costs where the shop says (INV-05). Goods are received into stock as they
-- come, in part or in full, each receipt one adjustment in the ledger with the reason "received"
-- naming the purchase order. See ADR-350 in docs/architecture/13-decision-log.md.

-- ---------------------------------------------------------------------------------------------
-- Suppliers: who the shop buys from, with a mobile number in E.164 form.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.suppliers (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  phone      text        CHECK (phone ~ '^\+923[0-9]{9}$'),
  note       text        CHECK (length(note) BETWEEN 1 AND 5000),
  version    integer     NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

CREATE UNIQUE INDEX suppliers_name_key ON inventory.suppliers (shop_id, lower(name));

SELECT platform.enable_tenant_isolation('inventory.suppliers');

-- ---------------------------------------------------------------------------------------------
-- Purchase order numbers: PO-1 onwards, per shop, taken last in the transaction that creates one.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.purchase_order_counters (
  shop_id     uuid    PRIMARY KEY,
  next_number integer NOT NULL CHECK (next_number > 0)
);

SELECT platform.enable_tenant_isolation('inventory.purchase_order_counters');

-- ---------------------------------------------------------------------------------------------
-- Purchase orders. Open until every line is received in full, or the shop closes it with what
-- came; then closed_at says when.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.purchase_orders (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  number      integer     NOT NULL CHECK (number > 0),
  supplier_id uuid        NOT NULL,
  location_id uuid        NOT NULL,
  status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'received', 'closed')),
  -- The supplier's own number for it, such as its bill's.
  reference   text        CHECK (length(reference) BETWEEN 1 AND 255),
  note        text        CHECK (length(note) BETWEEN 1 AND 5000),
  expected_on date,
  closed_at   timestamptz,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT purchase_orders_number_key UNIQUE (shop_id, number),
  CONSTRAINT purchase_orders_closed_at_check CHECK ((status = 'open') = (closed_at IS NULL)),
  FOREIGN KEY (shop_id, supplier_id) REFERENCES inventory.suppliers (shop_id, id),
  FOREIGN KEY (shop_id, location_id) REFERENCES inventory.locations (shop_id, id)
);

CREATE INDEX purchase_orders_status_idx ON inventory.purchase_orders (shop_id, status, number);
CREATE INDEX purchase_orders_supplier_idx ON inventory.purchase_orders (shop_id, supplier_id);

SELECT platform.enable_tenant_isolation('inventory.purchase_orders');

-- ---------------------------------------------------------------------------------------------
-- Lines: a variant, as it was named when ordered, how many and how many came. Not a reference to
-- the variant, which may be deleted: what was ordered of it stays on the order.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.purchase_order_lines (
  shop_id           uuid    NOT NULL,
  purchase_order_id uuid    NOT NULL,
  id                uuid    NOT NULL DEFAULT platform.uuidv7(),
  position          integer NOT NULL CHECK (position >= 0),
  variant_id        uuid    NOT NULL,
  product_title     text    NOT NULL,
  variant_title     text    NOT NULL,
  sku               text,
  quantity          integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000000),
  received          integer NOT NULL DEFAULT 0,
  -- What one costs, in minor units of the shop's currency; null where the shop gave none.
  unit_cost         bigint  CHECK (unit_cost >= 0),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT purchase_order_lines_variant_key UNIQUE (shop_id, purchase_order_id, variant_id),
  CONSTRAINT purchase_order_lines_received_check CHECK (received BETWEEN 0 AND quantity),
  FOREIGN KEY (shop_id, purchase_order_id) REFERENCES inventory.purchase_orders (shop_id, id)
    ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('inventory.purchase_order_lines');
