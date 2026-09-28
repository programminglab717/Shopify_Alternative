-- 0013 · Customers' numbers, merging and erasure
-- A customer can have more than one mobile number, such as a second SIM: merging a duplicate
-- brings its numbers along, so orders from any of them find the same customer. Erasing a customer
-- removes their personal data and keeps their orders, for the shop's accounts, without it. See
-- ADR-026 in docs/architecture/13-decision-log.md and docs/engineering/conventions.md.

-- Every number of every customer, the one on the customer row included. A number belongs to one
-- customer of a shop at a time.
CREATE TABLE customers.customer_phones (
  shop_id     uuid        NOT NULL,
  phone       text        NOT NULL CHECK (phone ~ '^\+923[0-9]{9}$'),
  customer_id uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, phone),
  -- What the customer row's own foreign key below points at.
  CONSTRAINT customer_phones_owner_key UNIQUE (shop_id, phone, customer_id),
  -- Deferred: a new customer's number is claimed before the customer row is written.
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers.customers (shop_id, id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX customer_phones_customer_idx ON customers.customer_phones (shop_id, customer_id);

SELECT platform.enable_tenant_isolation('customers.customer_phones');

-- Every customer's number so far. Checked at once: deferred checks left pending would stop the
-- table changes below.
SET CONSTRAINTS ALL IMMEDIATE;
INSERT INTO customers.customer_phones (shop_id, phone, customer_id, created_at)
SELECT shop_id, phone, id, created_at FROM customers.customers;

-- A customer's main number, the one marketing consent is for, is one of their numbers.
ALTER TABLE customers.customers
  ADD CONSTRAINT customers_phone_registered FOREIGN KEY (shop_id, phone, id)
      REFERENCES customers.customer_phones (shop_id, phone, customer_id)
      DEFERRABLE INITIALLY DEFERRED;

-- The consent ledger is append-only for request code (0011). Merging and erasure are the only
-- changes it takes, through these two functions, and only in the caller's shop.

-- Moves a merged duplicate's consent history to the customer it was merged into.
CREATE FUNCTION customers.move_consent_history(p_from uuid, p_into uuid)
  RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH moved AS (
    UPDATE customers.consent_events
       SET customer_id = p_into
     WHERE shop_id = platform.current_shop_id() AND customer_id = p_from
    RETURNING 1
  )
  SELECT count(*)::integer FROM moved
$$;

-- Deletes an erased customer's consent history.
CREATE FUNCTION customers.erase_consent_history(p_customer uuid)
  RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH erased AS (
    DELETE FROM customers.consent_events
     WHERE shop_id = platform.current_shop_id() AND customer_id = p_customer
    RETURNING 1
  )
  SELECT count(*)::integer FROM erased
$$;

ALTER FUNCTION customers.move_consent_history(uuid, uuid) OWNER TO hatti_system_role;
ALTER FUNCTION customers.erase_consent_history(uuid) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION customers.move_consent_history(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION customers.erase_consent_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customers.move_consent_history(uuid, uuid) TO hatti_app_role;
GRANT EXECUTE ON FUNCTION customers.erase_consent_history(uuid) TO hatti_app_role;

-- Once their customer's data is erased, orders keep what the shop's accounts need: no name,
-- number, email, street or note, but the city and province, the items and the amounts.
ALTER TABLE orders.orders
  ALTER COLUMN phone DROP NOT NULL,
  ADD COLUMN customer_erased_at timestamptz,
  ADD CONSTRAINT orders_erased_check CHECK ((phone IS NULL) = (customer_erased_at IS NOT NULL));
