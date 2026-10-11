-- 0170 · Transfers between a shop's locations
-- Stock sent from one location to another and on its way until it is received there (INV-04):
-- sending takes it off on hand where it leaves, each receipt adds to on hand where it arrives, and
-- cancelling puts back where it left what had not arrived. Each is one adjustment in the ledger
-- naming the transfer. See ADR-360 in docs/architecture/13-decision-log.md.

-- ---------------------------------------------------------------------------------------------
-- Transfer numbers: T-1 onwards, per shop, taken last in the transaction that sends one.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.transfer_counters (
  shop_id     uuid    PRIMARY KEY,
  next_number integer NOT NULL CHECK (next_number > 0)
);

SELECT platform.enable_tenant_isolation('inventory.transfer_counters');

-- ---------------------------------------------------------------------------------------------
-- Transfers. On their way until every line is received in full, or the shop cancels what has not
-- arrived; then closed_at says when.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.transfers (
  shop_id        uuid        NOT NULL,
  id             uuid        NOT NULL DEFAULT platform.uuidv7(),
  number         integer     NOT NULL CHECK (number > 0),
  origin_id      uuid        NOT NULL,
  destination_id uuid        NOT NULL,
  status         text        NOT NULL DEFAULT 'in_transit'
                             CHECK (status IN ('in_transit', 'received', 'cancelled')),
  -- Such as the courier's tracking number, or the bilty of the goods transport.
  reference      text        CHECK (length(reference) BETWEEN 1 AND 255),
  note           text        CHECK (length(note) BETWEEN 1 AND 5000),
  closed_at      timestamptz,
  version        integer     NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT transfers_number_key UNIQUE (shop_id, number),
  CONSTRAINT transfers_closed_at_check CHECK ((status = 'in_transit') = (closed_at IS NULL)),
  CONSTRAINT transfers_locations_check CHECK (origin_id <> destination_id),
  FOREIGN KEY (shop_id, origin_id) REFERENCES inventory.locations (shop_id, id),
  FOREIGN KEY (shop_id, destination_id) REFERENCES inventory.locations (shop_id, id)
);

CREATE INDEX transfers_status_idx ON inventory.transfers (shop_id, status, number);

SELECT platform.enable_tenant_isolation('inventory.transfers');

-- ---------------------------------------------------------------------------------------------
-- Lines: a variant, as it was named when sent, how many and how many arrived. Not a reference to
-- the variant, which may be deleted: what was sent of it stays on the transfer.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.transfer_lines (
  shop_id       uuid    NOT NULL,
  transfer_id   uuid    NOT NULL,
  id            uuid    NOT NULL DEFAULT platform.uuidv7(),
  position      integer NOT NULL CHECK (position >= 0),
  variant_id    uuid    NOT NULL,
  product_title text    NOT NULL,
  variant_title text    NOT NULL,
  sku           text,
  quantity      integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000000),
  received      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, id),
  CONSTRAINT transfer_lines_variant_key UNIQUE (shop_id, transfer_id, variant_id),
  CONSTRAINT transfer_lines_received_check CHECK (received BETWEEN 0 AND quantity),
  FOREIGN KEY (shop_id, transfer_id) REFERENCES inventory.transfers (shop_id, id)
    ON DELETE CASCADE
);

-- What of a variant is on its way to a location is read with what runs low there.
CREATE INDEX transfer_lines_variant_idx ON inventory.transfer_lines (shop_id, variant_id);

SELECT platform.enable_tenant_isolation('inventory.transfer_lines');
