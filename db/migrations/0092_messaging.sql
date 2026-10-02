-- 0092 · Messaging
-- What a shop's customers are told about their orders (MSG-01): placed, shipped, delivered and
-- cancelled, on WhatsApp from Hatti's shared notifications number (MSG-03), or by SMS. Each
-- message waits in messaging.messages until the worker sends it, once by its key however often
-- its event comes, and follows it to delivery through WhatsApp's webhooks; an SMS goes in its
-- place when WhatsApp cannot deliver it. Customers who reply "STOP" or "band karo" hear no more
-- from the shop on that channel (MSG-09).
-- See ADR-146 in docs/architecture/13-decision-log.md.

CREATE SCHEMA messaging;

GRANT USAGE ON SCHEMA messaging TO hatti_app_role, hatti_system_role;

-- How the shop's messages go: WhatsApp for every update (rich) or for those with buttons alone,
-- SMS for the rest (economy); their language; and the notifications it turned off.
CREATE TABLE messaging.settings (
  shop_id      uuid        PRIMARY KEY,
  routing      text        NOT NULL DEFAULT 'rich' CHECK (routing IN ('rich', 'economy')),
  language     text        NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ur')),
  -- Checked by the application, which knows the notifications there are.
  disabled     text[]      NOT NULL DEFAULT '{}'
                           CHECK (cardinality(disabled) <= 50
                                  AND array_position(disabled, NULL) IS NULL),
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('messaging.settings');

CREATE TABLE messaging.messages (
  shop_id             uuid        NOT NULL,
  id                  uuid        NOT NULL DEFAULT platform.uuidv7(),
  kind                text        NOT NULL CHECK (kind ~ '^[a-z_]{1,50}$'),
  channel             text        NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  -- E.164.
  recipient           text        NOT NULL CHECK (recipient ~ '^\+[1-9][0-9]{6,14}$'),
  language            text        NOT NULL CHECK (language IN ('en', 'ur')),
  variables           jsonb       NOT NULL DEFAULT '{}'
                                  CHECK (jsonb_typeof(variables) = 'object'
                                         AND octet_length(variables::text) <= 4096),
  order_id            uuid,
  customer_id         uuid,
  -- Sent once by it, however often its event comes: "order_placed:<order>".
  dedupe_key          text        NOT NULL CHECK (char_length(dedupe_key) <= 200),
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed',
                                                    'skipped')),
  attempts            integer     NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  provider            text        CHECK (char_length(provider) <= 50),
  provider_message_id text        CHECK (char_length(provider_message_id) <= 200),
  error               text        CHECK (char_length(error) <= 1000),
  -- The WhatsApp message an SMS went in place of.
  replaces            uuid,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, dedupe_key)
);

SELECT platform.enable_tenant_isolation('messaging.messages');

CREATE INDEX messages_due ON messaging.messages (next_attempt_at) WHERE status = 'pending';
-- WhatsApp messages sent and not delivered, for an SMS to go in their place.
CREATE INDEX messages_undelivered ON messaging.messages (sent_at)
  WHERE status = 'sent' AND channel = 'whatsapp';
-- The SMS that went in a WhatsApp message's place: each undelivered one is checked every round.
CREATE INDEX messages_replaces ON messaging.messages (shop_id, replaces)
  WHERE replaces IS NOT NULL;
CREATE INDEX messages_order ON messaging.messages (shop_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX messages_latest ON messaging.messages (shop_id, created_at DESC, id DESC);
-- Webhooks name a message by the provider's ID alone. Not unique: an SMS gateway's IDs are its
-- own, and one given twice must not undo a message sent.
CREATE INDEX messages_provider_id ON messaging.messages (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
-- An inbound reply names its sender alone: the shop that last wrote to them.
CREATE INDEX messages_recipient ON messaging.messages (channel, recipient, created_at DESC);

-- The numbers that asked the shop to stop, on a channel (MSG-09).
CREATE TABLE messaging.opt_outs (
  shop_id    uuid        NOT NULL,
  channel    text        NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  recipient  text        NOT NULL CHECK (recipient ~ '^\+[1-9][0-9]{6,14}$'),
  -- What they sent, as they sent it.
  said       text        CHECK (char_length(said) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, channel, recipient)
);

SELECT platform.enable_tenant_isolation('messaging.opt_outs');

-- The shops and messages WhatsApp's webhook names by their IDs, found before any shop is known.
-- SECURITY DEFINER lets the API, which works as one shop at a time, find them without seeing any
-- other shop's messages; what it then changes, it changes as the shop.
CREATE FUNCTION messaging.resolve_provider_messages(p_provider text, p_ids text[])
  RETURNS TABLE (shop_id uuid, message_id uuid, provider_message_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.shop_id, m.id, m.provider_message_id
    FROM messaging.messages m
   WHERE m.provider = p_provider AND m.provider_message_id = ANY (p_ids)
$$;

ALTER FUNCTION messaging.resolve_provider_messages(text, text[]) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION messaging.resolve_provider_messages(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging.resolve_provider_messages(text, text[]) TO hatti_app_role;

-- The shop that last wrote to a number on a channel: the one its "stop" is for, when it does not
-- reply to a message of the shop's (MSG-09).
CREATE FUNCTION messaging.resolve_last_sender(p_channel text, p_recipient text)
  RETURNS TABLE (shop_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.shop_id
    FROM messaging.messages m
   WHERE m.channel = p_channel AND m.recipient = p_recipient
   ORDER BY m.created_at DESC
   LIMIT 1
$$;

ALTER FUNCTION messaging.resolve_last_sender(text, text) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION messaging.resolve_last_sender(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging.resolve_last_sender(text, text) TO hatti_app_role;
