-- 0346 · Web chat
-- Shoppers write to the shop from its online store (MSG-10): a chat on its pages, kept as a
-- conversation of the inbox (MSG-05) beside WhatsApp's, which its staff answer there. A shopper
-- gives their name and mobile number to start one, so that the shop can find them again; each
-- browser that writes holds a session of its own, which reads only what was written since it
-- began. See ADR-810 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.conversations
  DROP CONSTRAINT conversations_channel_check,
  ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('whatsapp', 'web')),
  -- The name a shopper gave to chat on the online store; null on WhatsApp.
  ADD COLUMN customer_name text CHECK (char_length(customer_name) BETWEEN 1 AND 80);

CREATE TABLE messaging.web_chat_settings (
  shop_id     uuid        PRIMARY KEY,
  enabled     boolean     NOT NULL DEFAULT false,
  -- What the chat says before the shopper writes; null for Hatti's words.
  greeting    text        CHECK (char_length(greeting) BETWEEN 1 AND 200),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('messaging.web_chat_settings');

CREATE TABLE messaging.web_chat_sessions (
  shop_id          uuid        NOT NULL,
  -- SHA-256 of the token the shopper's browser keeps.
  token_hash       bytea       NOT NULL,
  conversation_id  uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, token_hash),
  FOREIGN KEY (shop_id, conversation_id)
    REFERENCES messaging.conversations (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('messaging.web_chat_sessions');

CREATE INDEX web_chat_sessions_conversation
  ON messaging.web_chat_sessions (shop_id, conversation_id);
