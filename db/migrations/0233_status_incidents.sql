-- 0233 · Hatti's status page (BIL-06)
-- Hatti's people post incidents, and maintenance ahead of time, with a command; each says which
-- of Hatti's parts it touches and how badly, and is followed by updates until it ends. The core's
-- public status page, its JSON, and a banner in every shop's admin read them. They belong to no
-- shop, so the application reads them and only the system login writes them. See ADR-498 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE trust.incidents (
  id          uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  kind        text        NOT NULL CHECK (kind IN ('incident', 'maintenance')),
  -- How badly what it touches works while it lasts.
  impact      text        NOT NULL CHECK (impact IN ('degraded', 'outage')),
  components  text[]      NOT NULL CHECK (
                cardinality(components) >= 1
                AND components <@ ARRAY['storefronts', 'checkout', 'admin', 'payments',
                                        'couriers', 'whatsapp', 'sms', 'email']::text[]),
  title       text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  title_ur    text        CHECK (char_length(title_ur) BETWEEN 1 AND 200),
  -- When it began, or when maintenance is to begin, and when maintenance is to end.
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz CHECK (ends_at > starts_at),
  resolved_at timestamptz CHECK (resolved_at >= starts_at),
  created_by  text        NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 100),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incidents_open ON trust.incidents (starts_at) WHERE resolved_at IS NULL;
CREATE INDEX incidents_resolved ON trust.incidents (resolved_at DESC) WHERE resolved_at IS NOT NULL;

-- What Hatti said of it, as it went: the first when it was posted, the last when it ended.
CREATE TABLE trust.incident_updates (
  id          uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  incident_id uuid        NOT NULL REFERENCES trust.incidents (id) ON DELETE CASCADE,
  status      text        NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring',
                                                     'resolved', 'scheduled', 'in_progress',
                                                     'completed')),
  body        text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  body_ur     text        CHECK (char_length(body_ur) BETWEEN 1 AND 2000),
  posted_by   text        NOT NULL CHECK (char_length(posted_by) BETWEEN 1 AND 100),
  posted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incident_updates_of ON trust.incident_updates (incident_id, posted_at);

GRANT SELECT ON trust.incidents, trust.incident_updates TO hatti_app_role, hatti_system_role;
GRANT INSERT, UPDATE ON trust.incidents, trust.incident_updates TO hatti_system_role;
