-- 0005 · Inventory
-- Locations, stock of each variant at each location, and an append-only ledger of every change.
-- available = on_hand − committed − reserved − safety_stock. See docs/engineering/conventions.md.

CREATE SCHEMA inventory;

GRANT USAGE ON SCHEMA inventory TO hatti_app_role, hatti_system_role;

-- ---------------------------------------------------------------------------------------------
-- Locations: where stock is kept, such as a warehouse or a shop. Once a shop has any, exactly one
-- is primary, and it stays active. Addresses are in Pakistan: a province code (ISO 3166-2:PK
-- suffix), a five-digit postcode and a mobile number in E.164 form, as courier pickups need.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.locations (
  shop_id                uuid        NOT NULL,
  id                     uuid        NOT NULL DEFAULT platform.uuidv7(),
  name                   text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  address1               text        CHECK (length(address1) BETWEEN 1 AND 255),
  address2               text        CHECK (length(address2) BETWEEN 1 AND 255),
  city                   text        CHECK (length(city) BETWEEN 1 AND 255),
  province_code          text        CHECK (province_code IN ('PB', 'SD', 'KP', 'BA', 'IS', 'GB', 'JK')),
  zip                    text        CHECK (zip ~ '^[0-9]{5}$'),
  phone                  text        CHECK (phone ~ '^\+923[0-9]{9}$'),
  is_primary             boolean     NOT NULL DEFAULT false,
  is_active              boolean     NOT NULL DEFAULT true,
  -- Whether online orders may be fulfilled from here, so its stock counts as sellable online.
  fulfills_online_orders boolean     NOT NULL DEFAULT true,
  deactivated_at         timestamptz,
  version                integer     NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT locations_primary_active_check CHECK (is_active OR NOT is_primary),
  CONSTRAINT locations_deactivated_at_check CHECK (is_active = (deactivated_at IS NULL))
);

CREATE UNIQUE INDEX locations_name_key ON inventory.locations (shop_id, lower(name));
CREATE UNIQUE INDEX locations_primary_key ON inventory.locations (shop_id) WHERE is_primary;

SELECT platform.enable_tenant_isolation('inventory.locations');

-- ---------------------------------------------------------------------------------------------
-- Items: how a variant's stock is counted. A variant without a row is not tracked and can always
-- be sold; its first stock change or setting creates the row. This is the one foreign key into
-- another module's tables: stock belongs to its variant and is deleted with it.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.items (
  shop_id          uuid        NOT NULL,
  variant_id       uuid        NOT NULL,
  -- The variant's product, for events and totals. A variant never moves to another product.
  product_id       uuid        NOT NULL,
  -- Whether sales are checked against stock.
  tracked          boolean     NOT NULL,
  -- At zero available: 'deny' stops selling, 'continue' sells on and available goes negative.
  inventory_policy text        NOT NULL DEFAULT 'deny'
                               CHECK (inventory_policy IN ('deny', 'continue')),
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, variant_id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES catalog.variants (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('inventory.items');

-- ---------------------------------------------------------------------------------------------
-- Levels: an item's quantities at one location.
--   on_hand       units there; negative only after fulfilling more than was recorded
--   committed     promised to placed orders not yet fulfilled
--   reserved      held for checkouts in progress
--   safety_stock  kept back, never sold online
--   available     what can still be sold
-- Quantities stay within ±100 million, so available cannot overflow.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.levels (
  shop_id      uuid        NOT NULL,
  variant_id   uuid        NOT NULL,
  location_id  uuid        NOT NULL,
  -- Names the level in events and the API.
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  on_hand      integer     NOT NULL DEFAULT 0 CHECK (on_hand BETWEEN -100000000 AND 100000000),
  committed    integer     NOT NULL DEFAULT 0 CHECK (committed BETWEEN 0 AND 100000000),
  reserved     integer     NOT NULL DEFAULT 0 CHECK (reserved BETWEEN 0 AND 100000000),
  safety_stock integer     NOT NULL DEFAULT 0 CHECK (safety_stock BETWEEN 0 AND 100000000),
  available    integer     GENERATED ALWAYS AS (on_hand - committed - reserved - safety_stock) STORED,
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, variant_id, location_id),
  CONSTRAINT levels_id_key UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES inventory.items (shop_id, variant_id)
    ON DELETE CASCADE,
  FOREIGN KEY (shop_id, location_id) REFERENCES inventory.locations (shop_id, id)
    ON DELETE CASCADE
);

CREATE INDEX levels_location_idx ON inventory.levels (shop_id, location_id);

SELECT platform.enable_tenant_isolation('inventory.levels');

-- ---------------------------------------------------------------------------------------------
-- The ledger. An adjustment is one change of stock and why: a stock count, a delivery, an order.
-- Its movements are the quantities it changed, with the values after. Request code may add rows,
-- never change or remove them. A location with movements cannot be deleted, only deactivated.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inventory.adjustments (
  shop_id                uuid        NOT NULL,
  id                     uuid        NOT NULL DEFAULT platform.uuidv7(),
  reason                 text        NOT NULL CHECK (reason ~ '^[a-z_]{1,64}$'),
  -- What caused it: an order ("hatti://orders/…"), or a document in another system.
  reference_document_uri text        CHECK (length(reference_document_uri) BETWEEN 1 AND 2048),
  actor_kind             text        NOT NULL CHECK (actor_kind IN ('app', 'staff', 'system')),
  -- The access token or the staff member; null for the system.
  actor_id               uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('inventory.adjustments');
REVOKE UPDATE, DELETE ON inventory.adjustments FROM hatti_app_role;

CREATE TABLE inventory.movements (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT platform.uuidv7(),
  adjustment_id   uuid        NOT NULL,
  variant_id      uuid        NOT NULL,
  location_id     uuid        NOT NULL,
  quantity_name   text        NOT NULL
                              CHECK (quantity_name IN ('on_hand', 'committed', 'reserved', 'safety_stock')),
  delta           integer     NOT NULL CHECK (delta <> 0),
  quantity_after  integer     NOT NULL,
  available_after integer     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, adjustment_id) REFERENCES inventory.adjustments (shop_id, id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES inventory.items (shop_id, variant_id)
    ON DELETE CASCADE,
  FOREIGN KEY (shop_id, location_id) REFERENCES inventory.locations (shop_id, id)
);

CREATE INDEX movements_variant_idx ON inventory.movements (shop_id, variant_id, id);
CREATE INDEX movements_location_idx ON inventory.movements (shop_id, location_id);

SELECT platform.enable_tenant_isolation('inventory.movements');
REVOKE UPDATE, DELETE ON inventory.movements FROM hatti_app_role;
