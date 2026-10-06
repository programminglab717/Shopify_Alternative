-- 0144 · Couriers' names for a shop's cities
-- A courier delivers to the cities on its own list, written its own way. A parcel's city is
-- matched to it through Pakistan's names for the city and their aliases; where none matches,
-- staff choose the courier's name for it from the nearest, and the shop keeps that for the next
-- parcel to the city with that courier (SHP-03). See ADR-233 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE logistics.shop_courier_cities (
  shop_id      uuid        NOT NULL,
  courier      text        NOT NULL CHECK (courier ~ '^[a-z][a-z_]{1,29}$'),
  -- The city as orders write it, by its letters and digits in lower case.
  city_key     text        NOT NULL CHECK (city_key ~ '^[^[:space:][:punct:]]{1,100}$'),
  -- The city as staff gave it, for showing.
  city         text        NOT NULL CHECK (char_length(city) BETWEEN 1 AND 100),
  -- The courier's own name for it, as its list writes it.
  courier_city text        NOT NULL CHECK (char_length(courier_city) BETWEEN 1 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, courier, city_key)
);

SELECT platform.enable_tenant_isolation('logistics.shop_courier_cities');
