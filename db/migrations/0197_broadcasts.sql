-- 0197 · Broadcasts
-- A shop's WhatsApp broadcasts (MKT-01): one of its own approved templates (ADR-420), sent from
-- its own number (ADR-419) to the customers of a segment who agreed to hear from it on WhatsApp,
-- or to all who did, at a time it chooses. The worker queues its messages a batch at a time,
-- keeping its place, and each message keeps the broadcast it went in, for the broadcast's counts.
-- See ADR-421 in docs/architecture/13-decision-log.md.

CREATE TABLE messaging.broadcasts (
  shop_id           uuid        NOT NULL,
  id                uuid        NOT NULL DEFAULT platform.uuidv7(),
  name              text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  -- The template as it was chosen: one deleted since leaves the broadcast unsent.
  template_id       uuid        NOT NULL,
  template_name     text        NOT NULL CHECK (template_name ~ '^[a-z0-9_]{1,100}$'),
  template_language text        NOT NULL CHECK (template_language IN ('en', 'ur')),
  -- Its body, {{1}} the customer's first name: what the broadcast says, as the admin shows it.
  template_body     text        NOT NULL CHECK (char_length(template_body) <= 1024),
  -- None: every customer who agreed to hear from the shop on WhatsApp.
  segment_id        uuid,
  segment_name      text        CHECK (char_length(segment_name) <= 255),
  send_at           timestamptz NOT NULL,
  status            text        NOT NULL DEFAULT 'scheduled'
                                CHECK (status IN ('scheduled', 'sending', 'sent', 'cancelled',
                                                  'failed')),
  error             text        CHECK (char_length(error) <= 500),
  -- The customers queued so far, and the last of them: its place, newest customers first.
  recipients        integer     NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  after_customer    uuid,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('messaging.broadcasts');

CREATE INDEX broadcasts_latest ON messaging.broadcasts (shop_id, created_at DESC, id DESC);
-- What the worker has to queue: those due and those it is part-way through.
CREATE INDEX broadcasts_due ON messaging.broadcasts (send_at)
  WHERE status IN ('scheduled', 'sending');

ALTER TABLE messaging.messages ADD COLUMN broadcast_id uuid;

-- A broadcast's messages, for its counts.
CREATE INDEX messages_broadcast ON messaging.messages (shop_id, broadcast_id, status)
  WHERE broadcast_id IS NOT NULL;
