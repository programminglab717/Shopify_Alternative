-- 0094 · Courier bookings
-- Shops connect their own courier accounts (SHP-01), their credentials sealed as Meta's tokens
-- are, and ask for orders to be booked with them (SHP-02): each booking waits here until the
-- worker books it through the courier's API, ships the order as a parcel with the courier's
-- tracking number, and then follows it (SHP-04). What each courier's statuses mean, and its names
-- for cities that differ from Hatti's (SHP-03), are data, so they change without a deploy
-- (ADR-010).
-- See ADR-149 in docs/architecture/13-decision-log.md.

CREATE TABLE logistics.courier_accounts (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT platform.uuidv7(),
  courier          text        NOT NULL CHECK (courier ~ '^[a-z][a-z_]{1,29}$'),
  name             text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  -- The account's API credentials, sealed for the shop (SecretBox); never shown again.
  credentials      text        NOT NULL CHECK (char_length(credentials) <= 4000),
  -- The credentials' last four characters, for staff to tell accounts apart.
  credentials_hint text        NOT NULL CHECK (char_length(credentials_hint) <= 4),
  -- Where the courier picks parcels up, by its own code for the shop's address.
  pickup_code      text        CHECK (char_length(pickup_code) <= 100),
  is_default       boolean     NOT NULL DEFAULT false,
  -- No new bookings once archived; its parcels are still followed.
  archived_at      timestamptz,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CHECK (NOT (is_default AND archived_at IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('logistics.courier_accounts');

CREATE UNIQUE INDEX courier_accounts_default ON logistics.courier_accounts (shop_id)
  WHERE is_default;

CREATE TABLE logistics.bookings (
  shop_id           uuid        NOT NULL,
  id                uuid        NOT NULL DEFAULT platform.uuidv7(),
  order_id          uuid        NOT NULL,
  -- The order's number, "#1043" without its mark, as it was booked.
  order_number      integer     NOT NULL,
  account_id        uuid        NOT NULL,
  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'booked', 'failed', 'cancelled')),
  attempts          integer     NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  error             text        CHECK (char_length(error) <= 1000),
  tracking_number   text        CHECK (char_length(tracking_number) <= 100),
  -- The cash the courier was asked to collect, in minor units.
  cod_amount        bigint      CHECK (cod_amount >= 0),
  -- The parcel shipped with the tracking number.
  fulfillment_id    uuid,
  -- What the courier last said of the parcel, as it said it, and what that means here.
  courier_status    text        CHECK (char_length(courier_status) <= 200),
  parcel_status     text        CHECK (parcel_status IN ('booked', 'in_transit',
                                                         'out_for_delivery', 'attempted',
                                                         'delivered', 'returning', 'returned',
                                                         'lost', 'cancelled')),
  tracked_at        timestamptz,
  -- When to ask the courier again; null once there is nothing more to hear.
  next_track_at     timestamptz,
  -- Who asked for it: the staff member or app it books for.
  requested_by_kind text        NOT NULL CHECK (requested_by_kind IN ('app', 'staff')),
  requested_by_id   text        NOT NULL CHECK (char_length(requested_by_id) <= 100),
  booked_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, account_id) REFERENCES logistics.courier_accounts (shop_id, id)
);

SELECT platform.enable_tenant_isolation('logistics.bookings');

-- An order is booked once at a time.
CREATE UNIQUE INDEX bookings_open_order ON logistics.bookings (shop_id, order_id)
  WHERE status IN ('pending', 'booked');
CREATE INDEX bookings_due ON logistics.bookings (next_attempt_at) WHERE status = 'pending';
CREATE INDEX bookings_to_track ON logistics.bookings (next_track_at)
  WHERE status = 'booked' AND next_track_at IS NOT NULL;
CREATE INDEX bookings_latest ON logistics.bookings (shop_id, created_at DESC, id DESC);
CREATE INDEX bookings_order ON logistics.bookings (shop_id, order_id);

-- What each courier's statuses mean here, by the status as it says it, in lower case.
CREATE TABLE logistics.courier_statuses (
  courier text NOT NULL CHECK (courier ~ '^[a-z][a-z_]{1,29}$'),
  raw     text NOT NULL CHECK (char_length(raw) BETWEEN 1 AND 200 AND raw = lower(raw)),
  status  text NOT NULL CHECK (status IN ('booked', 'in_transit', 'out_for_delivery', 'attempted',
                                          'delivered', 'returning', 'returned', 'lost',
                                          'cancelled')),
  PRIMARY KEY (courier, raw)
);

GRANT SELECT ON logistics.courier_statuses TO hatti_app_role, hatti_system_role;

-- PostEx's statuses, as its tracking says them (ADR-149).
INSERT INTO logistics.courier_statuses (courier, raw, status) VALUES
  ('postex', 'booked', 'booked'),
  ('postex', 'unbooked', 'booked'),
  ('postex', 'picked by postex', 'in_transit'),
  ('postex', 'postex warehouse', 'in_transit'),
  ('postex', 'at postex warehouse', 'in_transit'),
  ('postex', 'en-route to postex warehouse', 'in_transit'),
  ('postex', 'en route to destination', 'in_transit'),
  ('postex', 'out for delivery', 'out_for_delivery'),
  ('postex', 'attempted', 'attempted'),
  ('postex', 'delivery under review', 'attempted'),
  ('postex', 'delivered', 'delivered'),
  ('postex', 'out for return', 'returning'),
  ('postex', 'return in transit', 'returning'),
  ('postex', 'returned', 'returned'),
  ('postex', 'cancelled', 'cancelled'),
  ('postex', 'un-assigned by me', 'cancelled'),
  ('postex', 'expired', 'cancelled');

-- A courier's own name for a city where it is not Hatti's (`@hatti/pk`'s), for booking.
CREATE TABLE logistics.courier_cities (
  courier      text NOT NULL CHECK (courier ~ '^[a-z][a-z_]{1,29}$'),
  city         text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 100),
  courier_city text NOT NULL CHECK (char_length(courier_city) BETWEEN 1 AND 100),
  PRIMARY KEY (courier, city)
);

GRANT SELECT ON logistics.courier_cities TO hatti_app_role, hatti_system_role;
