-- 0108 · Email for accounts
-- Hatti sends its own email about accounts (ONB-01): a link that proves an account's email, and
-- one that resets a forgotten password. Each carries a token of its own, of which only a digest is
-- kept. See ADR-165 in docs/architecture/13-decision-log.md.

CREATE TABLE identity.email_tokens (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  purpose    text        NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  -- Where the link went: it proves this address, and works while it is still the account's.
  email      text        NOT NULL,
  -- SHA-256 of the token the link carries.
  token_hash bytea       NOT NULL CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  -- When it was used, or another link of its kind sent in its place.
  used_at    timestamptz,
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_tokens_token_hash_key UNIQUE (token_hash)
);

-- An account's links of a kind lately; and those old enough to go, after 30 days.
CREATE INDEX email_tokens_user_idx ON identity.email_tokens (user_id, purpose, created_at DESC);
CREATE INDEX email_tokens_created_at_idx ON identity.email_tokens (created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.email_tokens TO hatti_identity_role;
