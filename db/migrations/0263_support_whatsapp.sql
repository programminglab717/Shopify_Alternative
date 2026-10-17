-- 0263 · Support requests on WhatsApp
-- What a shop's staff write to Hatti's support WhatsApp number (BIL-05) is kept as a request of
-- their shop, as one from the admin is: the account whose proved number wrote is found through
-- identity's function, never its tables; what they write while a request of theirs is open is
-- added to it, a thread of what they wrote and what Hatti sent back. Hatti's answer goes back on
-- WhatsApp too, within the day WhatsApp lets a business write freely, and is followed to delivery.
-- See ADR-560 in docs/architecture/13-decision-log.md.

ALTER TABLE billing.support_requests
  -- Where it was asked: in the admin, or on Hatti's support WhatsApp number.
  ADD COLUMN channel         text NOT NULL DEFAULT 'admin' CHECK (channel IN ('admin', 'whatsapp')),
  -- The number, E.164, that wrote about it on WhatsApp, which the answer goes back to; null for
  -- a request no one wrote about there.
  ADD COLUMN whatsapp_from   text CHECK (whatsapp_from ~ '^\+[1-9][0-9]{6,14}$'),
  -- When they last wrote about it on WhatsApp: the answer goes back within a day of it.
  ADD COLUMN last_inbound_at timestamptz,
  ADD CONSTRAINT support_requests_whatsapp_from
    CHECK (channel = 'admin' OR whatsapp_from IS NOT NULL),
  ADD CONSTRAINT support_requests_last_inbound
    CHECK ((whatsapp_from IS NULL) = (last_inbound_at IS NULL));

-- A message on WhatsApp may be a word or a photo alone; one from the admin says more.
ALTER TABLE billing.support_requests DROP CONSTRAINT support_requests_message_check;
ALTER TABLE billing.support_requests ADD CONSTRAINT support_requests_message_check
  CHECK (char_length(message) BETWEEN CASE channel WHEN 'whatsapp' THEN 1 ELSE 10 END AND 2000);

-- Where a member of staff's next message goes: their open requests, and the shops they asked in.
CREATE INDEX support_requests_of_opener ON billing.support_requests (opened_by, created_at DESC);

-- What was written about a request on WhatsApp, and what Hatti sent back, oldest first.
CREATE TABLE billing.support_request_messages (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  request_id  uuid        NOT NULL,
  direction   text        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body        text        CHECK (char_length(body) BETWEEN 1 AND 4096),
  -- What else it held, as WhatsApp names it: "image", "audio"; null for words alone.
  media_kind  text        CHECK (media_kind ~ '^[a-z_]{1,30}$'),
  -- WhatsApp's ID for it, which a webhook delivered twice names again; null for an answer
  -- WhatsApp did not take.
  whatsapp_id text        CHECK (char_length(whatsapp_id) BETWEEN 1 AND 200),
  -- How an answer went, as WhatsApp says; null for what staff wrote.
  status      text        CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  -- Why WhatsApp did not take or deliver an answer.
  error       text        CHECK (char_length(error) <= 1000),
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, request_id)
    REFERENCES billing.support_requests (shop_id, id) ON DELETE CASCADE,
  CHECK (body IS NOT NULL OR media_kind IS NOT NULL),
  CHECK ((direction = 'outbound') = (status IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('billing.support_request_messages');

CREATE INDEX support_request_messages_of_request
  ON billing.support_request_messages (shop_id, request_id, at);
-- Each message WhatsApp names is kept once.
CREATE UNIQUE INDEX support_request_messages_whatsapp_id
  ON billing.support_request_messages (whatsapp_id) WHERE whatsapp_id IS NOT NULL;

-- The shops whose staff a number is: the active memberships, in active shops, of the active
-- account that proved `p_phone` with a code, with the account's language; a collaborator's past
-- its end is none. Across shops, as WhatsApp's webhook knows no shop, and SECURITY DEFINER, so
-- that billing, which never reads identity's tables, learns no more than this.
CREATE FUNCTION identity.staff_of_phone(p_phone text)
  RETURNS TABLE (user_id uuid, shop_id uuid, language text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, m.shop_id, u.language
    FROM identity.users u
    JOIN identity.memberships m ON m.user_id = u.id
    JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active'
   WHERE u.phone_e164 = p_phone
     AND u.phone_verified_at IS NOT NULL
     AND u.status = 'active'
     AND m.status = 'active'
     AND (m.expires_at IS NULL OR m.expires_at > now())
   ORDER BY m.created_at, m.shop_id
$$;

ALTER FUNCTION identity.staff_of_phone(text) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.staff_of_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.staff_of_phone(text) TO hatti_app_role;

-- Where a member of staff's message on WhatsApp goes, among the shops `p_shop_ids` they are staff
-- of, found before any shop is known: their open request last written about, with its shop; else
-- the shop they last asked in, with no request.
CREATE FUNCTION billing.resolve_support_sender(p_user_id uuid, p_shop_ids uuid[])
  RETURNS TABLE (shop_id uuid, request_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.shop_id, CASE WHEN r.status = 'open' THEN r.id END
    FROM billing.support_requests r
   WHERE r.opened_by = p_user_id AND r.shop_id = ANY (p_shop_ids)
   ORDER BY r.status = 'open' DESC, greatest(r.created_at, r.last_inbound_at) DESC, r.id DESC
   LIMIT 1
$$;

-- The answers WhatsApp's webhook names by their IDs, found before any shop is known, as
-- messaging.resolve_conversation_messages finds the inbox's replies (0257).
CREATE FUNCTION billing.resolve_support_messages(p_ids text[])
  RETURNS TABLE (shop_id uuid, message_id uuid, whatsapp_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.shop_id, m.id, m.whatsapp_id
    FROM billing.support_request_messages m
   WHERE m.direction = 'outbound' AND m.whatsapp_id = ANY (p_ids)
$$;

ALTER FUNCTION billing.resolve_support_sender(uuid, uuid[]) OWNER TO hatti_system_role;
ALTER FUNCTION billing.resolve_support_messages(text[]) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION billing.resolve_support_sender(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.resolve_support_messages(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.resolve_support_sender(uuid, uuid[]) TO hatti_app_role;
GRANT EXECUTE ON FUNCTION billing.resolve_support_messages(text[]) TO hatti_app_role;
