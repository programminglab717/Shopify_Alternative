-- 0275 · Messages from the contact form
-- What shoppers write through the online store's contact form (OS-08), Shopify's
-- `{% form 'contact' %}`, is kept for the shop's staff to read beside the inbox: who wrote, how to
-- answer them (an email, a mobile number, or both), what they wrote, the form's other fields, the
-- page it was sent from, and whether staff have read it. Erased with the customer whose number or
-- email it holds, and in their own file. See ADR-589 in docs/architecture/13-decision-log.md.

CREATE TABLE messaging.contact_messages (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  name       text        CHECK (char_length(name) BETWEEN 1 AND 255),
  -- Lower case.
  email      text        CHECK (char_length(email) BETWEEN 3 AND 254),
  -- E.164.
  phone      text        CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  -- The form's other fields, by their names under contact[…]: {"Order number": "#1042"}.
  fields     jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(fields) = 'object'),
  -- The storefront's path the form was on, and its language.
  page       text        CHECK (char_length(page) BETWEEN 1 AND 512),
  language   text        NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ur')),
  -- Where it came from, as the storefront saw the shopper.
  ip         inet,
  user_agent text        CHECK (char_length(user_agent) <= 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  PRIMARY KEY (shop_id, id),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

SELECT platform.enable_tenant_isolation('messaging.contact_messages');

CREATE INDEX contact_messages_latest ON messaging.contact_messages (shop_id, id DESC);
CREATE INDEX contact_messages_unread
  ON messaging.contact_messages (shop_id, id DESC) WHERE read_at IS NULL;
CREATE INDEX contact_messages_phone ON messaging.contact_messages (shop_id, phone);
CREATE INDEX contact_messages_email ON messaging.contact_messages (shop_id, email);
