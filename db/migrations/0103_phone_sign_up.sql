-- 0103 · Phone sign-up
-- Merchants open an account, and sign in, with their mobile number and a one-time code sent to it
-- on WhatsApp or by SMS, as most in Pakistan would rather than with an email (ONB-01). An account
-- has an email, a proved number, or both; a number proved is one account's alone. See ADR-159 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE identity.users
  ALTER COLUMN email DROP NOT NULL,
  -- When the number was proved with a code sent to it: from then on it signs the account in.
  ADD COLUMN phone_verified_at timestamptz,
  ADD CONSTRAINT users_phone_verified_check
    CHECK (phone_verified_at IS NULL OR phone_e164 IS NOT NULL),
  ADD CONSTRAINT users_contact_check CHECK (email IS NOT NULL OR phone_verified_at IS NOT NULL);

-- A number proved is one account's.
CREATE UNIQUE INDEX users_verified_phone_key ON identity.users (phone_e164)
  WHERE phone_verified_at IS NOT NULL;

-- The codes sent to prove numbers, to sign in or open an account. Only a digest of each is kept.
CREATE TABLE identity.phone_codes (
  id                 uuid        PRIMARY KEY,
  -- A Pakistani mobile, in E.164.
  phone              text        NOT NULL CHECK (phone ~ '^\+923[0-9]{9}$'),
  channel            text        NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  -- SHA-256 of the code with the row's ID.
  code_hash          bytea       NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts           smallint    NOT NULL DEFAULT 0,
  expires_at         timestamptz NOT NULL,
  verified_at        timestamptz,
  -- A number proved for no account yet: a digest of the token that opens one with it, for a
  -- while, once.
  sign_up_token_hash bytea       CHECK (octet_length(sign_up_token_hash) = 32),
  used_at            timestamptz,
  ip                 inet,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phone_codes_sign_up_token_key UNIQUE (sign_up_token_hash)
);

-- The codes a number was sent lately; and those old enough to go, after 30 days.
CREATE INDEX phone_codes_phone_idx ON identity.phone_codes (phone, created_at DESC);
CREATE INDEX phone_codes_created_at_idx ON identity.phone_codes (created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.phone_codes TO hatti_identity_role;
