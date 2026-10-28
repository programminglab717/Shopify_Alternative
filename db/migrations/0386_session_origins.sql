-- 0386 · Sessions by where they came from
-- Each day's sessions of a shop's online store (ANL-02), in its time zone, by where they came
-- from, the page they landed on and their device: counted once a session, as it began, by the
-- storefronts in Valkey; the worker keeps each day's counts so far here, as it keeps the sessions
-- (ADR-180). The 100 most of each a day are kept by name, the rest together as "(other)". See
-- ADR-884 in docs/architecture/13-decision-log.md.

CREATE TABLE online_store.session_origins (
  shop_id    uuid        NOT NULL,
  -- In the shop's time zone.
  day        date        NOT NULL,
  dimension  text        NOT NULL CHECK (dimension IN ('source', 'landing_page', 'device')),
  -- "google", "direct", "/collections/eid", "mobile".
  value      text        NOT NULL CHECK (char_length(value) BETWEEN 1 AND 200),
  sessions   integer     NOT NULL CHECK (sessions >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, day, dimension, value)
);

SELECT platform.enable_tenant_isolation('online_store.session_origins');
