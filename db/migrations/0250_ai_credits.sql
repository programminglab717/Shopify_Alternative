-- 0250 · AI credits
-- Each plan includes AI credits a month (BIL-01): Free 10, Starter 50, Growth 150, Pro 600. A
-- draft the AI gives a shop, of a product's copy or of translations, spends one; a refusal or a
-- failure spends none. They come back at the start of each month in Pakistan's time. See ADR-533
-- in docs/architecture/13-decision-log.md.

CREATE TABLE billing.ai_credit_uses (
  shop_id  uuid        NOT NULL,
  id       uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- What the AI drafted.
  use      text        NOT NULL CHECK (use IN ('product_copy', 'translation')),
  used_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('billing.ai_credit_uses');

CREATE INDEX ai_credit_uses_of_shop ON billing.ai_credit_uses (shop_id, used_at);
