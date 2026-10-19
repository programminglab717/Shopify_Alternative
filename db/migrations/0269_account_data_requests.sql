-- 0269 · Customers asking for their data, or its erasure, from their account
-- A shopper signed in to their account on the storefront (ADR-570) asks for the file of their own
-- data the shop's staff can give them (ADR-102), or for their erasure, as staff ask for it on
-- their behalf (ADR-110). The customer asked, so the customer is who the records name: an erasure
-- request's and the audit log's actor may now be the customer themselves, by their ID. Their file
-- is made as staff's is, and storage keeps it for a day behind short-lived signed links: one a day,
-- the one kept given again until it goes. See ADR-572 in docs/architecture/13-decision-log.md.

ALTER TABLE customers.erasure_requests DROP CONSTRAINT erasure_requests_actor_kind_check;
ALTER TABLE customers.erasure_requests
  ADD CONSTRAINT erasure_requests_actor_kind_check
    CHECK (actor_kind IN ('app', 'staff', 'customer'));
-- A customer has no role.
ALTER TABLE customers.erasure_requests
  ADD CONSTRAINT erasure_requests_customer_role
    CHECK (actor_kind <> 'customer' OR (actor_id = customer_id AND actor_role IS NULL));

ALTER TABLE platform.audit_log DROP CONSTRAINT audit_log_actor_kind_check;
ALTER TABLE platform.audit_log
  ADD CONSTRAINT audit_log_actor_kind_check
    CHECK (actor_kind IN ('app', 'staff', 'support', 'customer'));

CREATE TABLE checkout.account_data_exports (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- Whose file it is: the customer the shopper's account was when they asked.
  customer_id uuid        NOT NULL,
  -- Where storage keeps it: shops/{shopId}/customer-data/{id}.json.
  key         text        NOT NULL,
  -- Bytes of the file.
  size        integer     NOT NULL CHECK (size >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- When storage lets it go, and the worker's sweep deletes the row: a day after it was made, or
  -- at once, once its customer is merged into another or erased.
  expires_at  timestamptz NOT NULL CHECK (expires_at <= created_at + interval '1 day'),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('checkout.account_data_exports');

-- A customer's file kept, the newest first.
CREATE INDEX account_data_exports_customer
  ON checkout.account_data_exports (shop_id, customer_id, created_at DESC);
-- Those whose time is up, for the worker's sweep across shops.
CREATE INDEX account_data_exports_expiry ON checkout.account_data_exports (expires_at);
