-- 0303 · A product's personalisation fields
-- What a shop asks the shopper for on a product it makes to order (CAT-15): the name to embroider,
-- the initials to engrave, a choice among threads. Its page asks for each as a property of the
-- cart line, which the order's line keeps (ADR-687). See ADR-689 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE catalog.product_personalisation (
  shop_id    uuid        NOT NULL,
  product_id uuid        NOT NULL,
  -- The fields in the order its page asks for them:
  -- [{"name": "Name", "kind": "text", "required": true, "maxLength": 20, "choices": []}, ...].
  fields     jsonb       NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, product_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('catalog.product_personalisation');
