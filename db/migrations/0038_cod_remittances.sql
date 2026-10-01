-- 0038 · Couriers' remittance statements
-- Couriers collect cash on delivery and pay it over later, less their charges and the tax they
-- withhold, with a statement of the parcels it is for (COD-10). A shop imports the statement as
-- the courier sends it: each line is matched to a parcel by its tracking number, and its cash
-- received on the parcel's order. The logistics module's, as courier bookings will be. See
-- ADR-067 in docs/architecture/13-decision-log.md.

CREATE SCHEMA logistics;

GRANT USAGE ON SCHEMA logistics TO hatti_app_role, hatti_system_role;

CREATE TABLE logistics.cod_remittances (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL,
  -- The courier, as staff named it when importing the statement.
  courier    text        NOT NULL CHECK (length(courier) BETWEEN 1 AND 100),
  -- The statement's number or the payment's reference, when given.
  reference  text        CHECK (length(reference) BETWEEN 1 AND 100),
  line_count integer     NOT NULL CHECK (line_count > 0),
  -- In minor units: the cash the courier collected on the statement's parcels, its charges and
  -- the tax it withheld, what it paid over, and what of the cash was received on orders.
  collected  bigint      NOT NULL CHECK (collected >= 0),
  charges    bigint      NOT NULL CHECK (charges >= 0),
  tax        bigint      NOT NULL CHECK (tax >= 0),
  paid       bigint      NOT NULL,
  received   bigint      NOT NULL CHECK (received >= 0),
  -- Who imported it.
  actor_kind text        NOT NULL CHECK (actor_kind IN ('staff', 'app')),
  actor_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

-- A statement is imported once: its reference from the same courier again is refused.
CREATE UNIQUE INDEX cod_remittances_reference_key
  ON logistics.cod_remittances (shop_id, lower(courier), reference)
  WHERE reference IS NOT NULL;

CREATE INDEX cod_remittances_created_idx
  ON logistics.cod_remittances (shop_id, created_at DESC, id DESC);

CREATE TABLE logistics.cod_remittance_lines (
  shop_id         uuid    NOT NULL,
  remittance_id   uuid    NOT NULL,
  -- Its row in the file; the header is row 1.
  file_row        integer NOT NULL CHECK (file_row > 1),
  tracking_number text    NOT NULL CHECK (length(tracking_number) BETWEEN 1 AND 100),
  -- The parcel and the order it matched, with the order's number, which never changes. No
  -- foreign keys: they are the orders module's.
  fulfillment_id  uuid,
  order_id        uuid,
  order_number    integer,
  outcome         text    NOT NULL CHECK (outcome IN (
                    'received', 'short', 'over', 'unmatched', 'repeated', 'not_owed', 'charged')),
  collected       bigint  NOT NULL CHECK (collected >= 0),
  charges         bigint  NOT NULL CHECK (charges >= 0),
  tax             bigint  NOT NULL CHECK (tax >= 0),
  -- What the order still owed as the line was taken, and what of the line was received on it.
  owed            bigint  CHECK (owed >= 0),
  received        bigint  NOT NULL DEFAULT 0 CHECK (received >= 0),
  PRIMARY KEY (shop_id, remittance_id, file_row),
  FOREIGN KEY (shop_id, remittance_id)
    REFERENCES logistics.cod_remittances (shop_id, id) ON DELETE CASCADE
);

-- A parcel's cash is received once: its earlier lines are found by the parcel.
CREATE INDEX cod_remittance_lines_parcel_idx
  ON logistics.cod_remittance_lines (shop_id, fulfillment_id)
  WHERE fulfillment_id IS NOT NULL;

-- Couriers write tracking numbers their own way, and staff type them theirs: the orders module
-- finds parcels by them without spaces, in capitals.
CREATE INDEX fulfillments_tracking_key_idx
  ON orders.fulfillments (shop_id, upper(regexp_replace(tracking_number, '\s', '', 'g')))
  WHERE tracking_number IS NOT NULL;

SELECT platform.enable_tenant_isolation('logistics.cod_remittances');
SELECT platform.enable_tenant_isolation('logistics.cod_remittance_lines');
