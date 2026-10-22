-- 0317 · Hatti's legal documents' versions, as the worker first saw them
-- Each version of Hatti's terms, privacy policy, acceptable use policy, data processing agreement
-- and list of sub-processors ships with a release (ADR-736). The worker records each version the
-- first time it runs with it; one that follows an earlier version of the same document is a
-- change, which every shop open before it is told of, at its alerts number and by email to its
-- owner, once, and `notified_at` says when all were (ADR-742). The first version of each is not
-- announced: owners agreed to it in opening their shops. They belong to no shop, so only the
-- system login reads and writes them.

CREATE TABLE platform.legal_versions (
  -- The document's handle, "terms", and the day this version takes effect, YYYY-MM-DD.
  handle        text        NOT NULL CHECK (handle ~ '^[a-z][a-z-]{1,39}$'),
  version       text        NOT NULL CHECK (version ~ '^\d{4}-\d{2}-\d{2}$'),
  first_seen_at timestamptz NOT NULL,
  -- Whether it changes an earlier version, which shops are told of.
  announce      boolean     NOT NULL,
  notified_at   timestamptz CHECK (notified_at IS NULL OR announce),
  PRIMARY KEY (handle, version)
);

CREATE INDEX legal_versions_to_announce ON platform.legal_versions (first_seen_at)
  WHERE announce AND notified_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON platform.legal_versions TO hatti_system_role;
