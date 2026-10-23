-- 0323 · A time to answer the inbox by
-- A shop may say how soon its staff answer a customer who writes (MSG-06, ADR-760), in minutes;
-- a conversation keeps since when the customer has waited for an answer: from their first
-- message after the shop last answered, until the shop answers or closes it.

ALTER TABLE messaging.settings
  ADD COLUMN reply_target_minutes integer CHECK (reply_target_minutes BETWEEN 5 AND 1440);

ALTER TABLE messaging.conversations ADD COLUMN waiting_since timestamptz;

-- Open conversations whose customer wrote last are waiting since then.
UPDATE messaging.conversations c
   SET waiting_since = c.last_inbound_at
 WHERE c.status = 'open' AND c.last_inbound_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM messaging.conversation_messages m
      WHERE m.shop_id = c.shop_id AND m.conversation_id = c.id
        AND m.direction = 'outbound' AND m.at >= c.last_inbound_at);

-- The conversations waiting longest, first.
CREATE INDEX conversations_waiting_idx
  ON messaging.conversations (shop_id, waiting_since)
  WHERE waiting_since IS NOT NULL;
