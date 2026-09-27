-- 0002 · Staff identity
-- Global staff accounts, their credentials and sessions, and their memberships in shops. This is
-- control-plane data (docs/architecture/11-security-and-compliance.md §2.1). Only the identity
-- login reads and writes it; request-serving code can only call identity.resolve_staff_access().

DO $$
BEGIN
  CREATE ROLE hatti_identity_role NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     AND NOT pg_has_role(current_user, 'hatti_identity_role', 'MEMBER') THEN
    EXECUTE format('GRANT hatti_identity_role TO %I', current_user);
  END IF;
END
$$;

CREATE SCHEMA identity;

GRANT USAGE ON SCHEMA identity, platform, control TO hatti_identity_role;

-- Identity lists the shops a user belongs to.
GRANT SELECT ON control.shops TO hatti_identity_role;
CREATE POLICY identity_read ON control.shops FOR SELECT TO hatti_identity_role USING (true);

-- ---------------------------------------------------------------------------------------------
-- Accounts and credentials
-- ---------------------------------------------------------------------------------------------
CREATE TABLE identity.users (
  id                uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  -- Stored lowercased, so uniqueness ignores case.
  email             text        NOT NULL
                                CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'
                                       AND length(email) <= 254),
  email_verified_at timestamptz,
  name              text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  phone_e164        text        CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)
);

CREATE TABLE identity.password_credentials (
  user_id    uuid        PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  -- argon2id, PHC string format.
  hash       text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.totp_credentials (
  user_id                  uuid        PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  -- The confirmed secret, encrypted with SecretBox and bound to the user id. Null until the user
  -- has entered a code from their authenticator app.
  secret_encrypted         text,
  confirmed_at             timestamptz,
  -- A secret being set up. It replaces the confirmed one only after a correct code, so starting
  -- over never locks anyone out.
  pending_secret_encrypted text,
  -- The last time step used; a code is accepted once only.
  last_used_step           bigint,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((secret_encrypted IS NULL) = (confirmed_at IS NULL))
);

CREATE TABLE identity.recovery_codes (
  user_id   uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  code_hash bytea       NOT NULL,
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

-- ---------------------------------------------------------------------------------------------
-- Sessions: a short-lived access token and a rotating refresh token. Rotation keeps the previous
-- refresh token's hash, so presenting it again reveals a stolen token and ends the session.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE identity.sessions (
  id                          uuid        PRIMARY KEY,
  user_id                     uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  access_token_hash           bytea       NOT NULL,
  access_expires_at           timestamptz NOT NULL,
  refresh_token_hash          bytea       NOT NULL,
  previous_refresh_token_hash bytea,
  refreshed_at                timestamptz,
  -- Set when this session passed a second factor.
  mfa_verified_at             timestamptz,
  user_agent                  text,
  ip                          inet,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  last_used_at                timestamptz NOT NULL DEFAULT now(),
  -- Absolute end of the session; refreshing never extends it.
  expires_at                  timestamptz NOT NULL,
  revoked_at                  timestamptz,
  revoked_reason              text,
  CONSTRAINT sessions_access_token_hash_key UNIQUE (access_token_hash),
  CONSTRAINT sessions_refresh_token_hash_key UNIQUE (refresh_token_hash)
);

CREATE INDEX sessions_user_idx ON identity.sessions (user_id, created_at DESC);
CREATE INDEX sessions_previous_refresh_idx ON identity.sessions (previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL;

-- The step between a correct password and a second factor.
CREATE TABLE identity.mfa_challenges (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  token_hash bytea       NOT NULL,
  attempts   integer     NOT NULL DEFAULT 0,
  user_agent text,
  ip         inet,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfa_challenges_token_hash_key UNIQUE (token_hash)
);

-- ---------------------------------------------------------------------------------------------
-- Memberships: which users work in which shop, with which role preset
-- (docs/design/02-information-architecture.md §6).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE identity.memberships (
  user_id    uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  shop_id    uuid        NOT NULL REFERENCES control.shops (id),
  role       text        NOT NULL
                         CHECK (role IN ('owner', 'manager', 'confirmation_agent', 'packer',
                                         'marketer', 'accountant')),
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, shop_id)
);

CREATE UNIQUE INDEX memberships_one_owner_per_shop ON identity.memberships (shop_id)
  WHERE role = 'owner';
CREATE INDEX memberships_shop_idx ON identity.memberships (shop_id);

-- Sign-ins, failures and security changes, for the account activity page and investigations.
CREATE TABLE identity.auth_events (
  id          uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  user_id     uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  kind        text        NOT NULL,
  ip          inet,
  user_agent  text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_events_user_idx ON identity.auth_events (user_id, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO hatti_identity_role;

-- ---------------------------------------------------------------------------------------------
-- Request path: resolves a staff access token for one shop. Returns no row for an unknown,
-- expired or revoked token or a disabled user; returns a null role when the user has no active
-- membership in an active shop.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION identity.resolve_staff_access(p_access_token_hash bytea, p_shop_id uuid)
  RETURNS TABLE (
    user_id       uuid,
    session_id    uuid,
    mfa_verified  boolean,
    role          text,
    shop_currency text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.user_id, s.id, s.mfa_verified_at IS NOT NULL, m.role, sh.currency
    FROM identity.sessions s
    JOIN identity.users u ON u.id = s.user_id AND u.status = 'active'
    LEFT JOIN (identity.memberships m
               JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active')
           ON m.user_id = s.user_id AND m.shop_id = p_shop_id AND m.status = 'active'
   WHERE s.access_token_hash = p_access_token_hash
     AND s.revoked_at IS NULL
     AND s.access_expires_at > now()
     AND s.expires_at > now()
$$;

ALTER FUNCTION identity.resolve_staff_access(bytea, uuid) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.resolve_staff_access(bytea, uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO hatti_app_role;
GRANT EXECUTE ON FUNCTION identity.resolve_staff_access(bytea, uuid) TO hatti_app_role;
