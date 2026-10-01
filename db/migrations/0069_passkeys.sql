-- 0069 · Passkeys
-- Staff sign in with a passkey (WebAuthn), which passes the second factor on its own, or with
-- their password and then a passkey, an authenticator app's code or a recovery code. A passkey is
-- added from a session, one that passed a second factor once the account has one. See ADR-100 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE identity.passkeys (
  id            uuid        PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  -- The credential's ID as WebAuthn gives it, base64url: what a browser offers to sign in with.
  credential_id text        NOT NULL UNIQUE
                            CHECK (credential_id ~ '^[A-Za-z0-9_-]+$'
                                   AND char_length(credential_id) BETWEEN 16 AND 1366),
  -- Its public key, COSE-encoded, as the authenticator gave it when it was added.
  public_key    bytea       NOT NULL,
  -- The authenticator's signature counter; 0 for those that keep none, as synced passkeys do.
  counter       bigint      NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports    text[]      NOT NULL DEFAULT '{}',
  -- Synced across its owner's devices, or kept on one.
  multi_device  boolean     NOT NULL,
  backed_up     boolean     NOT NULL,
  -- What its owner called it: "Work laptop".
  name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE INDEX passkeys_user_idx ON identity.passkeys (user_id, created_at);

-- A WebAuthn challenge, answered once before it expires: to add a passkey, or to sign in with
-- one alone. One answered after a password is kept with the sign-in's challenge instead.
CREATE TABLE identity.passkey_challenges (
  id         uuid        PRIMARY KEY,
  -- Base64url, as it comes back in the response's client data.
  challenge  text        NOT NULL UNIQUE,
  purpose    text        NOT NULL CHECK (purpose IN ('register', 'sign_in')),
  -- Whose passkey is being added; null for signing in, before anyone is known.
  user_id    uuid        REFERENCES identity.users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose = 'register') = (user_id IS NOT NULL))
);

CREATE INDEX passkey_challenges_expiry_idx ON identity.passkey_challenges (expires_at);

ALTER TABLE identity.mfa_challenges
  -- The WebAuthn challenge a passkey of the user's answers, where they have one.
  ADD COLUMN passkey_challenge text;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON identity.passkeys, identity.passkey_challenges
  TO hatti_identity_role;
