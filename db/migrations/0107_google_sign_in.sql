-- 0107 · Google sign-in
-- Merchants sign up and in with their Google account, the last of ONB-01's ways in. Google's ID
-- token, checked against the keys Google publishes, names the account by its `sub`. A Google
-- account signs in to the one account it opened, or was connected to from it; an email alike never
-- connects one. See ADR-164 in docs/architecture/13-decision-log.md.

CREATE TABLE identity.google_accounts (
  -- Google's ID for the account, which never changes and is never another's.
  subject           text        PRIMARY KEY CHECK (subject ~ '^[!-~]{1,255}$'),
  user_id           uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  -- Its email at Google, as Google last gave it: the account's own may be another.
  email             text        NOT NULL
                                CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'
                                       AND length(email) <= 254),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_signed_in_at timestamptz,
  -- One Google account to an account.
  CONSTRAINT google_accounts_user_key UNIQUE (user_id)
);

-- The nonces Google's sign-in starts with: each answered once, by the ID token it comes back in,
-- before it expires.
CREATE TABLE identity.google_nonces (
  nonce      text        PRIMARY KEY CHECK (nonce ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX google_nonces_expiry_idx ON identity.google_nonces (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON identity.google_accounts, identity.google_nonces
  TO hatti_identity_role;
