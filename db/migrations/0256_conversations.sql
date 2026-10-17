-- 0256 · The inbox's conversations
-- What customers write to a shop on WhatsApp is kept for its staff to read (MSG-05): a
-- conversation for each customer's number, its messages as they came, and how many its staff have
-- not read. A message to a shop's own number is that shop's; one to Hatti's shared number is the
-- shop's whose message it answers, else the one that last wrote to the number. See ADR-545 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE messaging.conversations (
  shop_id             uuid        NOT NULL,
  id                  uuid        NOT NULL DEFAULT platform.uuidv7(),
  channel             text        NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  -- E.164.
  customer_phone      text        NOT NULL CHECK (customer_phone ~ '^\+[1-9][0-9]{6,14}$'),
  -- The number the customer last wrote to: the shop's own, by its WhatsApp ID; null for Hatti's
  -- shared number.
  via_phone_number_id text        CHECK (via_phone_number_id ~ '^[0-9]{1,30}$'),
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- Messages the shop's staff have not read.
  unread              integer     NOT NULL DEFAULT 0 CHECK (unread >= 0),
  last_message_at     timestamptz NOT NULL,
  -- When the customer last wrote: WhatsApp lets the shop answer freely for a day after.
  last_inbound_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, channel, customer_phone)
);

SELECT platform.enable_tenant_isolation('messaging.conversations');

CREATE INDEX conversations_latest
  ON messaging.conversations (shop_id, last_message_at DESC, id DESC);

CREATE TABLE messaging.conversation_messages (
  shop_id             uuid        NOT NULL,
  id                  uuid        NOT NULL DEFAULT platform.uuidv7(),
  conversation_id     uuid        NOT NULL,
  direction           text        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- What was written, or the button pressed; null for anything else.
  body                text        CHECK (char_length(body) BETWEEN 1 AND 4096),
  -- What else a message held, as WhatsApp names it: "image", "audio", "location".
  media_kind          text        CHECK (media_kind ~ '^[a-z_]{1,30}$'),
  -- WhatsApp's ID for it, which a webhook delivered twice names again.
  provider_message_id text        CHECK (char_length(provider_message_id) <= 200),
  at                  timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, conversation_id)
    REFERENCES messaging.conversations (shop_id, id) ON DELETE CASCADE,
  CHECK (body IS NOT NULL OR media_kind IS NOT NULL)
);

SELECT platform.enable_tenant_isolation('messaging.conversation_messages');

CREATE INDEX conversation_messages_of
  ON messaging.conversation_messages (shop_id, conversation_id, at DESC, id DESC);
CREATE UNIQUE INDEX conversation_messages_provider_id
  ON messaging.conversation_messages (shop_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- The shop whose own WhatsApp number WhatsApp's webhook names by its ID, found before any shop is
-- known, as messaging.resolve_provider_messages finds messages (0092).
CREATE FUNCTION messaging.resolve_whatsapp_number(p_phone_number_id text)
  RETURNS TABLE (shop_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.shop_id FROM messaging.whatsapp_accounts a WHERE a.phone_number_id = p_phone_number_id
$$;

ALTER FUNCTION messaging.resolve_whatsapp_number(text) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION messaging.resolve_whatsapp_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging.resolve_whatsapp_number(text) TO hatti_app_role;
