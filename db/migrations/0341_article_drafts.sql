-- 0341 · AI drafts of articles
-- A shop's staff may ask for an AI draft of a blog article from what they want it to say
-- (MKT-15): the draft comes back to the article's form to check and save, and is never kept
-- here. Each ask is logged with what it cost, in the provider's tokens, thirty a day at most, and
-- each draft given spends one of the shop's AI credits. See ADR-801 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE online_store.article_drafts (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- The blog it was asked for, if one was named; the blog may since be gone.
  blog_id       uuid,
  language      text        NOT NULL CHECK (language IN ('en', 'ur', 'roman_ur')),
  -- What came of it: a draft, or the model's refusal, a failure, an answer that did not fit.
  outcome       text        NOT NULL CHECK (outcome IN ('drafted', 'refused', 'failed', 'invalid')),
  input_tokens  integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('online_store.article_drafts');

CREATE INDEX article_drafts_recent ON online_store.article_drafts (shop_id, created_at);

-- An article's draft spends a credit as a product's copy and translations do (ADR-533).
ALTER TABLE billing.ai_credit_uses DROP CONSTRAINT ai_credit_uses_use_check;
ALTER TABLE billing.ai_credit_uses
  ADD CONSTRAINT ai_credit_uses_use_check
  CHECK (use IN ('product_copy', 'translation', 'article'));
