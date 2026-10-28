-- 0383 · Cashiers at the till (POS-07)
-- Staff sign in at a shared till with a PIN of their own, 4 to 6 digits, kept as a scrypt verifier,
-- never the PIN; no two of a shop's staff share one. Signing in gives the till a sealed token its
-- sales carry, made offline too, so each sale names who rang it up. A till's sign-ins lock for a
-- while after wrong PINs. See ADR-874 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.pos_staff_pins (
  shop_id      uuid        NOT NULL,
  -- The member of staff: no foreign key, as staff live in the identity database.
  user_id      uuid        NOT NULL,
  -- Their name as the till shows it and the Z report counts by.
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  pin_verifier text        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, user_id)
);

SELECT platform.enable_tenant_isolation('orders.pos_staff_pins');

CREATE TABLE orders.pos_pin_tries (
  shop_id      uuid        NOT NULL,
  session_id   uuid        NOT NULL,
  failures     integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_until timestamptz,
  PRIMARY KEY (shop_id, session_id),
  FOREIGN KEY (shop_id, session_id) REFERENCES orders.pos_sessions (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.pos_pin_tries');

ALTER TABLE orders.pos_sales
  ADD COLUMN cashier_id   uuid,
  ADD COLUMN cashier_name text CHECK (length(cashier_name) BETWEEN 1 AND 80),
  ADD CONSTRAINT pos_sales_cashier_check CHECK ((cashier_id IS NULL) = (cashier_name IS NULL));
