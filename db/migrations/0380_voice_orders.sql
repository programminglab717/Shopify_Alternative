-- 0380 · Voice-note orders (MSG-11)
-- A customer's WhatsApp voice note, heard by Hatti's own speech-to-text server and read by the AI
-- into what it orders, answered with the shop's checkout holding it, as the shop allows: off until
-- it turns it on, as each voice note read spends one of its AI credits. What was heard is kept on
-- the message, for its staff to read in the inbox; the audio is never kept. See ADR-871 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE billing.ai_credit_uses DROP CONSTRAINT ai_credit_uses_use_check;
ALTER TABLE billing.ai_credit_uses
  ADD CONSTRAINT ai_credit_uses_use_check
  CHECK (use IN ('product_copy', 'translation', 'article', 'report_question',
                 'transfer_receipt', 'support_reply', 'visual_search', 'voice_order'));

-- WhatsApp's ID for a message's media, to fetch it by; what a voice note was heard to say; and
-- when one was taken to be heard, once.
ALTER TABLE messaging.conversation_messages
  ADD COLUMN media_id         text CHECK (length(media_id) <= 200),
  ADD COLUMN transcript       text CHECK (length(transcript) <= 4000),
  ADD COLUMN voice_claimed_at timestamptz;

CREATE TABLE messaging.voice_order_settings (
  shop_id    uuid        PRIMARY KEY,
  enabled    boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('messaging.voice_order_settings');

CREATE TABLE messaging.voice_orders (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  message_id    uuid        NOT NULL,
  -- What came of it: answered with a checkout, read into things the shop doesn't sell, read into
  -- no order; or not heard, too long to hear, or the AI's failure.
  outcome       text        NOT NULL
                CHECK (outcome IN ('answered', 'unmatched', 'no_order', 'not_heard', 'too_long',
                                   'failed')),
  items         integer     NOT NULL DEFAULT 0 CHECK (items >= 0),
  matched       integer     NOT NULL DEFAULT 0 CHECK (matched >= 0),
  input_tokens  integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('messaging.voice_orders');

CREATE INDEX voice_orders_recent ON messaging.voice_orders (shop_id, created_at);
