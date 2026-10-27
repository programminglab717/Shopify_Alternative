-- 0354 · Pushes to shoppers (OS-14)
-- Shoppers turn on notifications from a shop's online store, installed or not (ADR-833): each
-- browser's subscription with its push service is kept for that shop, its endpoint one of the
-- push services browsers use, never any other address. The shop sends a push campaign, its
-- words and the page of its own it opens, which the worker pushes to every subscribed browser
-- in marketing hours, a batch at a time from where it got to, forgetting the subscriptions their
-- push service says are gone (ADR-834).
-- See ADR-833 and ADR-834 in docs/architecture/13-decision-log.md.

CREATE TABLE messaging.shopper_push_subscriptions (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  endpoint     text        NOT NULL CHECK (char_length(endpoint) <= 1000
                                           AND endpoint ~ '^https://'),
  p256dh       text        NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{86,88}$'),
  auth         text        NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{16,24}$'),
  -- The language of the page it was turned on from.
  locale       text        NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ur')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  -- Pushes in a row that failed; reset by one that goes.
  failures     integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, endpoint)
);

SELECT platform.enable_tenant_isolation('messaging.shopper_push_subscriptions');

CREATE TABLE messaging.push_campaigns (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  title        text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  body         text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 180),
  -- The shop's page it opens, a path from its root: "/collections/eid".
  path         text        NOT NULL CHECK (char_length(path) <= 500 AND path ~ '^/([^/\s]|$)'),
  status       text        NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent')),
  -- The last subscription pushed to, in ID order, for the next batch to go on from.
  cursor_id    uuid,
  sent         integer     NOT NULL DEFAULT 0 CHECK (sent >= 0),
  failed       integer     NOT NULL DEFAULT 0 CHECK (failed >= 0),
  gone         integer     NOT NULL DEFAULT 0 CHECK (gone >= 0),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  PRIMARY KEY (shop_id, id),
  CONSTRAINT push_campaigns_sent_at_check CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('messaging.push_campaigns');

CREATE INDEX push_campaigns_sending ON messaging.push_campaigns (created_at)
  WHERE status = 'sending';
