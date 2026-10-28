-- 0385 · Hatti's console
-- Hatti's own people work in a console of their own (ADM-08, 11 §2.2), signed in through Hatti's
-- identity provider, which asks for their security keys: its sessions last a working day, end
-- after half an hour unused, and reach nothing but the console. Each thing done there is logged,
-- by whom, before it is done. See ADR-876 in docs/architecture/13-decision-log.md.

-- A sign-in through Hatti's provider, from the console's start to the session it gives.
CREATE TABLE identity.console_logins (
  state_hash    bytea       PRIMARY KEY,
  nonce         text        NOT NULL,
  code_verifier text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  -- Set once the provider answered for one of Hatti's agents.
  handoff_hash  bytea       UNIQUE,
  user_id       uuid        REFERENCES identity.users (id) ON DELETE CASCADE,
  redeemed_at   timestamptz
);

CREATE INDEX console_logins_expiry ON identity.console_logins (expires_at);

-- A session in the console: an agent's, as their provider signed them in.
CREATE TABLE identity.console_sessions (
  id           uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  token_hash   bytea       NOT NULL UNIQUE,
  user_id      uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  -- As the provider vouched for it.
  email        text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  ip           text,
  user_agent   text,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '12 hours')
);

CREATE INDEX console_sessions_user_idx ON identity.console_sessions (user_id, created_at DESC);

-- What Hatti's people did in the console, written before it is done, never changed or deleted.
CREATE TABLE identity.console_actions (
  id         uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  session_id uuid        NOT NULL REFERENCES identity.console_sessions (id),
  user_id    uuid        NOT NULL,
  email      text        NOT NULL,
  -- "support_request.answer"
  action     text        NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  -- The public ID of what it was done to: "sreq_…", "shop_…".
  subject    text        CHECK (char_length(subject) <= 100),
  details    jsonb       NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX console_actions_at_idx ON identity.console_actions (at DESC);
CREATE INDEX console_actions_subject_idx ON identity.console_actions (subject, at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.console_logins TO hatti_identity_role;
GRANT SELECT, INSERT, UPDATE ON identity.console_sessions TO hatti_identity_role;
GRANT SELECT, INSERT ON identity.console_actions TO hatti_identity_role;
