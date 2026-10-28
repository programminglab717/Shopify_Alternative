-- 0359 · Questions of the shop's numbers (ANL-08)
-- A merchant asks of their numbers in English, Urdu or Roman Urdu; the AI reads the question into
-- one of Hatti's reports, which Hatti runs and shows (ADR-844). Each ask is kept with what it was
-- read into and what it cost, for the day's limit; an answer spends an AI credit, as drafts do.
-- See ADR-844 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.report_questions (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  question      text        NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  -- What it was read into: answered, not a question of the numbers, or the AI's failure.
  outcome       text        NOT NULL
                            CHECK (outcome IN ('answered', 'unanswerable', 'refused', 'failed',
                                               'invalid')),
  breakdown     text,
  period        text,
  columns       text[]      NOT NULL DEFAULT '{}',
  input_tokens  integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.report_questions');

CREATE INDEX report_questions_recent ON orders.report_questions (shop_id, created_at);

ALTER TABLE billing.ai_credit_uses DROP CONSTRAINT ai_credit_uses_use_check;
ALTER TABLE billing.ai_credit_uses
  ADD CONSTRAINT ai_credit_uses_use_check
  CHECK (use IN ('product_copy', 'translation', 'article', 'report_question'));
