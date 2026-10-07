-- 0156 · Courier pickups
-- Staff hand a courier account's parcels waiting to be picked up to the courier through its API
-- (SHP-02): PostEx makes its load sheet for the parcels and their pickup address, and Leopards
-- its own with the name and code of the rider who takes them. Each pickup keeps the courier's
-- number for it, its sheet and its parcels. See ADR-253 in docs/architecture/13-decision-log.md.

CREATE TABLE logistics.pickups (
  shop_id           uuid        NOT NULL,
  id                uuid        NOT NULL DEFAULT platform.uuidv7(),
  account_id        uuid        NOT NULL,
  -- Being asked of the courier; asked; or refused, its parcels left for the next one.
  status            text        NOT NULL DEFAULT 'requesting'
                                CHECK (status IN ('requesting', 'requested', 'failed')),
  parcel_count      integer     NOT NULL CHECK (parcel_count > 0),
  -- The courier's number for its load sheet, where it gives one.
  reference         text        CHECK (char_length(reference) <= 100),
  -- Who takes the parcels, where the courier asks: its rider's name and code.
  rider_name        text        CHECK (char_length(rider_name) <= 100),
  rider_code        text        CHECK (char_length(rider_code) <= 100),
  -- Where the courier's own load sheet is kept, where it gave one.
  document_key      text        CHECK (char_length(document_key) <= 500),
  -- What the courier said, when it refused.
  error             text        CHECK (char_length(error) <= 1000),
  requested_by_kind text        NOT NULL CHECK (requested_by_kind IN ('app', 'staff')),
  requested_by_id   text        NOT NULL CHECK (char_length(requested_by_id) <= 100),
  requested_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, account_id) REFERENCES logistics.courier_accounts (shop_id, id)
);

SELECT platform.enable_tenant_isolation('logistics.pickups');

CREATE INDEX pickups_latest ON logistics.pickups (shop_id, created_at DESC, id DESC);

-- The parcels each pickup handed over: a parcel its rider missed goes in a later one too.
CREATE TABLE logistics.pickup_parcels (
  shop_id    uuid NOT NULL,
  pickup_id  uuid NOT NULL,
  booking_id uuid NOT NULL,
  PRIMARY KEY (shop_id, pickup_id, booking_id),
  FOREIGN KEY (shop_id, pickup_id) REFERENCES logistics.pickups (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, booking_id) REFERENCES logistics.bookings (shop_id, id)
);

SELECT platform.enable_tenant_isolation('logistics.pickup_parcels');

CREATE INDEX pickup_parcels_booking ON logistics.pickup_parcels (shop_id, booking_id);
