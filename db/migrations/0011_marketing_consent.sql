-- 0011 · Marketing consent
-- Whether each customer agreed to marketing on WhatsApp, SMS and email, and a ledger of every
-- change: what they agreed to, where, when, and who recorded it. Transactional messages (order
-- confirmation, tracking) need no consent; marketing needs it per channel.
-- See docs/architecture/11-security-and-compliance.md §7 and docs/engineering/conventions.md.

-- The current state per channel, and when the customer gave it. Consent belongs to a number or
-- an address: a new number or email starts again at not_subscribed.
ALTER TABLE customers.customers
  ADD COLUMN whatsapp_consent    text NOT NULL DEFAULT 'not_subscribed'
    CHECK (whatsapp_consent IN ('not_subscribed', 'subscribed', 'unsubscribed')),
  ADD COLUMN whatsapp_consent_at timestamptz,
  ADD COLUMN sms_consent         text NOT NULL DEFAULT 'not_subscribed'
    CHECK (sms_consent IN ('not_subscribed', 'subscribed', 'unsubscribed')),
  ADD COLUMN sms_consent_at      timestamptz,
  ADD COLUMN email_consent       text NOT NULL DEFAULT 'not_subscribed'
    CHECK (email_consent IN ('not_subscribed', 'subscribed', 'unsubscribed')),
  ADD COLUMN email_consent_at    timestamptz,
  ADD CONSTRAINT customers_email_consent_needs_email CHECK (email_consent <> 'subscribed' OR email IS NOT NULL);

-- ---------------------------------------------------------------------------------------------
-- The consent ledger. Append-only: request code can add to it, never change it.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE customers.consent_events (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL,
  customer_id  uuid        NOT NULL,
  channel      text        NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  state        text        NOT NULL CHECK (state IN ('not_subscribed', 'subscribed', 'unsubscribed')),
  -- Where the customer said so; contact_changed when a new number or email reset it.
  source       text        NOT NULL
               CHECK (source IN ('manual', 'api', 'import', 'checkout', 'reply', 'contact_changed')),
  -- What they agreed to, e.g. the text beside a checkbox. Required to subscribe.
  wording      text        CHECK (length(wording) BETWEEN 1 AND 1000),
  -- The number or email address it was for.
  contact      text        NOT NULL CHECK (length(contact) BETWEEN 1 AND 254),
  actor_kind   text        NOT NULL CHECK (actor_kind IN ('app', 'staff', 'system')),
  actor_id     uuid,
  -- When the customer said so, which may be before it was recorded (an import, say).
  collected_at timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT consent_events_subscribe_wording CHECK (state <> 'subscribed' OR wording IS NOT NULL),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers.customers (shop_id, id)
);

CREATE INDEX consent_events_customer_idx ON customers.consent_events (shop_id, customer_id, id DESC);

SELECT platform.enable_tenant_isolation('customers.consent_events');
REVOKE UPDATE, DELETE ON customers.consent_events FROM hatti_app_role;
