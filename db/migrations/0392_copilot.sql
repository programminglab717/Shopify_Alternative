-- 0392 · The merchant copilot (AI-01)
-- Staff ask in English, Urdu or Roman Urdu; the AI reads the request into a draft of a discount
-- code, a customer segment or a report, which staff confirm before anything is made (ADR-894).
-- Each request is kept with what it was read into and what it cost, for the day's limit; a draft
-- spends an AI credit.
-- See ADR-894 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.copilot_requests (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  request       text        NOT NULL CHECK (char_length(request) BETWEEN 1 AND 400),
  -- What it was read into: a draft of its kind, none, a draft that did not check, or the AI's
  -- failure.
  outcome       text        NOT NULL
                            CHECK (outcome IN ('discount', 'segment', 'report', 'none',
                                               'unchecked', 'refused', 'failed', 'invalid')),
  input_tokens  integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.copilot_requests');

CREATE INDEX copilot_requests_recent ON orders.copilot_requests (shop_id, created_at);

ALTER TABLE billing.ai_credit_uses DROP CONSTRAINT ai_credit_uses_use_check;
ALTER TABLE billing.ai_credit_uses
  ADD CONSTRAINT ai_credit_uses_use_check
  CHECK (use IN ('product_copy', 'translation', 'article', 'report_question',
                 'transfer_receipt', 'support_reply', 'visual_search', 'voice_order', 'copilot'));
