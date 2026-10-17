-- 0257 · Replies from the inbox
-- A shop's staff answer a customer's conversation (MSG-05) in their own words, within the day
-- WhatsApp lets a business write freely after a customer's last message, from the number the
-- customer wrote to. Each reply is kept with who wrote it and how WhatsApp says it went. See
-- ADR-546 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.conversation_messages
  -- How a reply went, as WhatsApp's webhook says: sent, delivered, read or failed. Null for what
  -- customers wrote.
  ADD COLUMN status     text CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  -- Why WhatsApp could not deliver a reply.
  ADD COLUMN error      text CHECK (char_length(error) <= 1000),
  -- Who wrote a reply: a member of staff, or an app with its token.
  ADD COLUMN actor_kind text CHECK (actor_kind IN ('app', 'staff')),
  ADD COLUMN actor_id   uuid,
  ADD CONSTRAINT conversation_messages_reply_status
    CHECK ((direction = 'outbound') = (status IS NOT NULL)),
  ADD CONSTRAINT conversation_messages_reply_actor
    CHECK ((direction = 'outbound') = (actor_kind IS NOT NULL AND actor_id IS NOT NULL));

-- The replies WhatsApp's webhook names by their IDs, found before any shop is known, as
-- messaging.resolve_provider_messages finds messages (0092).
CREATE FUNCTION messaging.resolve_conversation_messages(p_ids text[])
  RETURNS TABLE (shop_id uuid, message_id uuid, provider_message_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.shop_id, m.id, m.provider_message_id
    FROM messaging.conversation_messages m
   WHERE m.direction = 'outbound' AND m.provider_message_id = ANY (p_ids)
$$;

ALTER FUNCTION messaging.resolve_conversation_messages(text[]) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION messaging.resolve_conversation_messages(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging.resolve_conversation_messages(text[]) TO hatti_app_role;
