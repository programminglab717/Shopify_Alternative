-- 0219 · AI drafts of products' copy
-- A shop's staff may ask for an AI draft of a product's title, description and search engine
-- title and description (CAT-20), from what they say of it, in English, Urdu or Roman Urdu. The
-- draft comes back to the product's form to check and save, and is never kept here. Each ask is
-- logged with what it cost, in the provider's tokens, so a shop asks a hundred times a day at
-- most and what AI costs each shop is known. See ADR-471 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.copy_drafts (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- The product it was for, once there is one; a product still being added has none.
  product_id    uuid,
  language      text        NOT NULL CHECK (language IN ('en', 'ur', 'roman_ur')),
  -- What came of it: a draft, or the model's refusal, a failure, an answer that did not fit.
  outcome       text        NOT NULL CHECK (outcome IN ('drafted', 'refused', 'failed', 'invalid')),
  input_tokens  integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('catalog.copy_drafts');

CREATE INDEX copy_drafts_recent ON catalog.copy_drafts (shop_id, created_at);
