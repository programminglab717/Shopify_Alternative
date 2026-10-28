-- 0363 · Customers answered by the AI (MSG-07)
-- A shop may let the AI answer its customers' messages, on WhatsApp and in its web chat, from its
-- policies and the customer's own orders, handing the conversation to its staff when it should
-- or when asked (ADR-849). Its replies are kept as the conversation's, by the AI; each reply it
-- gave, or why it gave none, is kept with what it cost, for the day's limit. A reply spends an AI
-- credit, as drafts do. See ADR-849 in docs/architecture/13-decision-log.md.

CREATE TABLE messaging.support_agent_settings (
  shop_id    uuid        NOT NULL PRIMARY KEY,
  enabled    boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('messaging.support_agent_settings');

-- A reply by the AI has no member of staff or app behind it.
ALTER TABLE messaging.conversation_messages
  DROP CONSTRAINT conversation_messages_actor_kind_check,
  DROP CONSTRAINT conversation_messages_reply_actor,
  ADD CONSTRAINT conversation_messages_actor_kind_check
    CHECK (actor_kind IN ('app', 'staff', 'ai')),
  ADD CONSTRAINT conversation_messages_reply_actor
    CHECK ((direction = 'outbound') =
           (actor_kind IS NOT NULL AND (actor_id IS NOT NULL OR actor_kind = 'ai')));

-- What the AI made of each message it was asked to answer.
CREATE TABLE messaging.support_agent_replies (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT platform.uuidv7(),
  conversation_id uuid        NOT NULL,
  -- The customer's message it answered.
  message_id      uuid        NOT NULL,
  -- Answered; answered and handed to staff; or the AI's failure, its answer sent nowhere.
  outcome         text        NOT NULL
                              CHECK (outcome IN ('replied', 'handed_off', 'refused', 'failed',
                                                 'invalid', 'unsent')),
  input_tokens    integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens   integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, message_id)
);

SELECT platform.enable_tenant_isolation('messaging.support_agent_replies');

CREATE INDEX support_agent_replies_recent
    ON messaging.support_agent_replies (shop_id, created_at);
CREATE INDEX support_agent_replies_by_conversation
    ON messaging.support_agent_replies (shop_id, conversation_id, created_at);

ALTER TABLE billing.ai_credit_uses DROP CONSTRAINT ai_credit_uses_use_check;
ALTER TABLE billing.ai_credit_uses
  ADD CONSTRAINT ai_credit_uses_use_check
  CHECK (use IN ('product_copy', 'translation', 'article', 'report_question',
                 'transfer_receipt', 'support_reply'));
