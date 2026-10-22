-- 0314 · Messages' content kept twelve months
-- What messages said is kept twelve months, as Hatti's privacy policy and data processing
-- agreement promise (ADR-736): after that the worker clears what a message to a customer said, its
-- template's variables and the error a provider gave, keeping that it was sent, to whom, how and
-- when; and deletes what customers wrote to a shop on WhatsApp and through its contact form, with a
-- conversation left with nothing in it. See ADR-738 in docs/architecture/13-decision-log.md.

-- Messages still holding what they said, oldest first, across shops.
CREATE INDEX messages_content_kept ON messaging.messages (created_at)
  WHERE variables <> '{}'::jsonb OR error IS NOT NULL;

CREATE INDEX conversation_messages_at ON messaging.conversation_messages (at);
CREATE INDEX conversations_last_message ON messaging.conversations (last_message_at);
CREATE INDEX contact_messages_created ON messaging.contact_messages (created_at);
