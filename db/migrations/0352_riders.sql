-- 0352 · Own riders
-- A shop's own riders and the deliveries it gives them (SHP-10, APP-06): a packed order handed to
-- a rider is shipped by them, its customer sent a code on WhatsApp to give the rider at the door;
-- the rider's page, opened from a link of their own with no account, lists what they carry,
-- takes the code, marks a delivery made or failed and the cash collected; and the cash a rider
-- hands over is recorded against what they collected. A rider's link and each delivery's code
-- are kept only as digests. See ADR-824 to ADR-827 in docs/architecture/13-decision-log.md.

CREATE TABLE logistics.riders (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  -- Mobile, as +923001234567.
  phone       text        NOT NULL CHECK (phone ~ '^\+92[0-9]{10}$'),
  active      boolean     NOT NULL DEFAULT true,
  -- The SHA-256 of the secret their page's link carries.
  link_hash   bytea       NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('logistics.riders');

CREATE TABLE logistics.rider_handovers (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  rider_id         uuid        NOT NULL,
  -- Minor units handed over.
  amount           bigint      NOT NULL CHECK (amount > 0),
  note             text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  received_by_kind text        NOT NULL CHECK (received_by_kind IN ('staff', 'app')),
  received_by      uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, rider_id) REFERENCES logistics.riders (shop_id, id)
);

SELECT platform.enable_tenant_isolation('logistics.rider_handovers');

CREATE TABLE logistics.rider_deliveries (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  rider_id        uuid        NOT NULL,
  order_id        uuid        NOT NULL,
  -- The parcel it is: one delivery a parcel.
  fulfillment_id  uuid        NOT NULL,
  status          text        NOT NULL DEFAULT 'out'
                              CHECK (status IN ('out', 'delivered', 'failed')),
  -- What the order owed in cash when it went out, in minor units.
  cash_due        bigint      NOT NULL CHECK (cash_due >= 0),
  cash_collected  bigint      NOT NULL DEFAULT 0 CHECK (cash_collected >= 0),
  -- The SHA-256 of the code its customer was sent; null where none could be sent.
  code_hash       bytea,
  -- Tries at the code, so that it is not guessed.
  code_tries      smallint    NOT NULL DEFAULT 0,
  -- Whether the rider gave the customer's code on delivering it.
  code_given      boolean     NOT NULL DEFAULT false,
  failed_reason   text        CHECK (char_length(failed_reason) <= 300),
  delivered_at    timestamptz,
  failed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, fulfillment_id),
  FOREIGN KEY (shop_id, rider_id) REFERENCES logistics.riders (shop_id, id)
);

SELECT platform.enable_tenant_isolation('logistics.rider_deliveries');

CREATE INDEX rider_deliveries_rider_idx ON logistics.rider_deliveries (shop_id, rider_id, created_at);

-- A rider's page, from its link alone: the rider and their shop, under the system role's lookup.
CREATE FUNCTION logistics.resolve_rider(p_hash bytea)
  RETURNS TABLE (shop_id uuid, rider_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.shop_id, r.id
    FROM logistics.riders r
    JOIN control.shops s ON s.id = r.shop_id AND s.status = 'active'
   WHERE r.link_hash = p_hash AND r.active
$$;

ALTER FUNCTION logistics.resolve_rider(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION logistics.resolve_rider(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION logistics.resolve_rider(bytea) TO hatti_app_role;
