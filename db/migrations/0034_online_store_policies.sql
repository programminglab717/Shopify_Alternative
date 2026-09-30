-- 0034 · Shop policies
-- A shop's refund, privacy, shipping and terms policies and its contact information, as
-- Shopify keeps them: HTML cleaned when saved, as pages' bodies are, one of each type. The
-- storefront shows them at /policies/{type}. See ADR-056 in docs/architecture/13-decision-log.md.

CREATE TABLE online_store.policies (
  shop_id    uuid        NOT NULL,
  type       text        NOT NULL CHECK (type IN (
               'refund_policy', 'privacy_policy', 'terms_of_service', 'shipping_policy',
               'contact_information'
             )),
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  body       text        NOT NULL CHECK (length(body) BETWEEN 1 AND 524288),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, type)
);

SELECT platform.enable_tenant_isolation('online_store.policies');
