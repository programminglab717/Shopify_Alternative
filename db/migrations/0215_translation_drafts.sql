-- 0215 · AI drafts of translations
-- A shop's staff may ask for an AI draft of a resource's fields in Urdu (CAT-07): the drafts come
-- back to the admin's form to check and save as translations, and are never kept here. Each ask
-- is logged with what it cost, in the provider's tokens, so a shop asks a hundred times a day at
-- most and what AI costs each shop is known. See ADR-463 in docs/architecture/13-decision-log.md.

CREATE TABLE online_store.translation_drafts (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- What was drafted: a resource of the shop's, by its ID, in a language, these fields.
  resource_id   uuid        NOT NULL,
  locale        text        NOT NULL CHECK (locale IN ('ur')),
  keys          text[]      NOT NULL CHECK (cardinality(keys) BETWEEN 1 AND 20),
  -- What came of it: drafts, or the model's refusal, a failure, an answer that did not fit.
  outcome       text        NOT NULL CHECK (outcome IN ('drafted', 'refused', 'failed', 'invalid')),
  input_tokens  integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('online_store.translation_drafts');

CREATE INDEX translation_drafts_recent ON online_store.translation_drafts (shop_id, created_at);
