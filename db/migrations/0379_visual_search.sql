-- 0379 · Visual search (SRC-07)
-- A shopper's photo, read by the AI into a search of the shop's catalog, as the shop allows: it
-- is off until the shop turns it on, as each photo spends one of the shop's AI credits, as its
-- other AI work does. Each photo read is kept as a row of what came of it, never the photo, for
-- the shop's daily cap and the AI's cost. See ADR-870 in docs/architecture/13-decision-log.md.

ALTER TABLE billing.ai_credit_uses DROP CONSTRAINT ai_credit_uses_use_check;
ALTER TABLE billing.ai_credit_uses
  ADD CONSTRAINT ai_credit_uses_use_check
  CHECK (use IN ('product_copy', 'translation', 'article', 'report_question',
                 'transfer_receipt', 'support_reply', 'visual_search'));

CREATE TABLE catalog.photo_search_settings (
  shop_id    uuid        PRIMARY KEY,
  enabled    boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('catalog.photo_search_settings');

CREATE TABLE catalog.photo_searches (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- What came of it: a search that found products, one that found none, a photo of no product,
  -- or the model's refusal, a failure, an answer that did not fit.
  outcome       text        NOT NULL
                CHECK (outcome IN ('found', 'none', 'no_product', 'refused', 'failed', 'invalid')),
  -- The search shown, where the photo was read into one.
  query         text,
  input_tokens  integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('catalog.photo_searches');

CREATE INDEX photo_searches_recent ON catalog.photo_searches (shop_id, created_at);
