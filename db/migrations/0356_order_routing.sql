-- Order routing (SHP-09, INV-10, ADR-839): the cities and provinces a location ships to. An
-- order goes out from a location that has all of it and serves its customer's city, else their
-- province, before the primary and the rest; a location that names none serves wherever.
ALTER TABLE inventory.locations
  ADD COLUMN serves_cities    text[] NOT NULL DEFAULT '{}'
             CHECK (cardinality(serves_cities) <= 100),
  ADD COLUMN serves_provinces text[] NOT NULL DEFAULT '{}'
             CHECK (serves_provinces <@ ARRAY['PB', 'SD', 'KP', 'BA', 'IS', 'GB', 'JK']);
