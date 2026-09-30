-- 0035 · E-contract logs
-- What a shopper agreed to in placing an order through checkout: the versions of the shop's
-- policies its page linked, and the address and browser it was placed from. Every version of a
-- policy is kept, never changed, so an order's can be shown as they were. See ADR-057 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE online_store.policy_versions (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  type       text        NOT NULL CHECK (type IN (
               'refund_policy', 'privacy_policy', 'terms_of_service', 'shipping_policy',
               'contact_information'
             )),
  body       text        NOT NULL CHECK (length(body) BETWEEN 1 AND 524288),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

-- The policies kept so far become their first versions, as they were last saved.
ALTER TABLE online_store.policies ADD COLUMN version_id uuid;

WITH versions AS (
  INSERT INTO online_store.policy_versions (shop_id, type, body, created_at)
  SELECT shop_id, type, body, updated_at FROM online_store.policies
  RETURNING shop_id, id, type
)
UPDATE online_store.policies p
   SET version_id = v.id
  FROM versions v
 WHERE p.shop_id = v.shop_id AND p.type = v.type;

ALTER TABLE online_store.policies
  ALTER COLUMN version_id SET NOT NULL,
  ADD FOREIGN KEY (shop_id, version_id) REFERENCES online_store.policy_versions (shop_id, id);

SELECT platform.enable_tenant_isolation('online_store.policy_versions');
REVOKE UPDATE, DELETE ON online_store.policy_versions FROM hatti_app_role;

-- An order its customer placed through checkout: the policy versions its page linked (none when
-- the shop had none), and where it came from, as Shopify's client details. Null for orders staff
-- and apps place. Erasing the customer clears the address and browser; the versions stay.
ALTER TABLE orders.orders
  ADD COLUMN agreed_policy_versions uuid[],
  ADD COLUMN client_ip inet,
  ADD COLUMN client_user_agent text CHECK (length(client_user_agent) <= 512);
