-- 0163 · Couriers' city names shared across shops
-- Where a courier's list names none of a city's spellings, the shop's staff give the courier's
-- name for it, which the shop keeps (ADR-233). A name three shops or more gave a city alike with a
-- courier, which no shop gave otherwise, is every shop's: a parcel's city is the shop's own name
-- for it, else Hatti's, else the one shops agree on, else the courier's list's. Hatti's people keep
-- Hatti's names, which come before any shops agree on, with a command (SHP-03). See ADR-260 in
-- docs/architecture/13-decision-log.md.

-- Shops' names for a city with a courier, across shops.
CREATE INDEX shop_courier_cities_shared ON logistics.shop_courier_cities (courier, city_key);

-- The names three shops or more gave alike, by their letters and digits, for the cities `p_keys`
-- with `p_courier`, which no shop gave otherwise: what every shop's parcels to them go as. It says
-- nothing of which shops gave them, and nothing at all of a name fewer gave.
CREATE FUNCTION logistics.shared_courier_cities(p_courier text, p_keys text[])
  RETURNS TABLE (city_key text, courier_city text, shops integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.city_key, min(c.courier_city), count(DISTINCT c.shop_id)::integer
    FROM logistics.shop_courier_cities c
   WHERE c.courier = p_courier AND c.city_key = ANY(p_keys)
   GROUP BY c.city_key
  HAVING count(DISTINCT c.shop_id) >= 3
     AND count(DISTINCT lower(regexp_replace(c.courier_city, '[^[:alnum:]]', '', 'g'))) = 1
$$;

ALTER FUNCTION logistics.shared_courier_cities(text, text[]) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION logistics.shared_courier_cities(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION logistics.shared_courier_cities(text, text[])
  TO hatti_app_role, hatti_system_role;

-- Hatti's people keep Hatti's names with a command, through the system login.
GRANT INSERT, UPDATE, DELETE ON logistics.courier_cities TO hatti_system_role;
