-- 0237 · Push notifications for staff
-- The admin installed on a phone tells its staff what needs them as it happens (APP-03): a new
-- order, one held for review, cash a courier remitted, stock running low. Each browser a member
-- of staff turns notifications on in subscribes with its push service, for the kinds they chose;
-- the worker pushes each to the staff whose role does that work, encrypted for that browser
-- alone, and forgets a subscription its push service says is gone.
-- See ADR-506 in docs/architecture/13-decision-log.md.

CREATE TABLE messaging.push_subscriptions (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- The member of staff whose browser it is, by their user ID.
  user_id      uuid        NOT NULL,
  endpoint     text        NOT NULL CHECK (char_length(endpoint) <= 1000
                                           AND endpoint ~ '^https://'),
  -- The browser's P-256 key and authentication secret, base64url, which messages are
  -- encrypted for.
  p256dh       text        NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{86,88}$'),
  auth         text        NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{16,24}$'),
  kinds        text[]      NOT NULL
                           CHECK (kinds <@ ARRAY['new_order', 'needs_review', 'cash_remitted',
                                                 'low_stock']::text[]),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  -- Pushes in a row that failed; reset by one that goes.
  failures     integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, endpoint)
);

SELECT platform.enable_tenant_isolation('messaging.push_subscriptions');

CREATE INDEX push_subscriptions_of_user ON messaging.push_subscriptions (shop_id, user_id);

-- What was pushed, by what it was about, so that an event heard twice, or a spell of low stock,
-- is pushed once.
CREATE TABLE messaging.push_deliveries (
  shop_id    uuid        NOT NULL,
  dedupe_key text        NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, dedupe_key)
);

SELECT platform.enable_tenant_isolation('messaging.push_deliveries');
