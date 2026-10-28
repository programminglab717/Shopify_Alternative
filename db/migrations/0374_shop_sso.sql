-- 0374 · Single sign-on for a shop's staff (ADM-09)
-- A shop's owner names the organisation's identity provider, any that speaks OpenID Connect
-- (Microsoft Entra ID, Google Workspace, Okta, Keycloak), and the email domains its staff sign in
-- with. Its members whose emails are of those domains sign in through it, by the authorization
-- code flow with PKCE, the provider's ID token checked against its published keys. Where the shop
-- requires it, its members other than the owner reach it only through a session the provider
-- began. No account is made: staff are invited first, as ever. See ADR-864 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE identity.shop_sso (
  shop_id       uuid        PRIMARY KEY REFERENCES control.shops (id) ON DELETE CASCADE,
  -- The provider's issuer, whose /.well-known/openid-configuration says the rest.
  issuer        text        NOT NULL CHECK (issuer ~ '^https?://' AND char_length(issuer) <= 500),
  client_id     text        NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 255),
  -- Sealed with the platform's keys, for this shop alone.
  client_secret text        NOT NULL,
  email_domains text[]      NOT NULL CHECK (cardinality(email_domains) BETWEEN 1 AND 10),
  -- Its members other than the owner reach it only through the provider.
  required      boolean     NOT NULL DEFAULT false,
  -- The provider asks for a second factor itself: its sessions count as two-step verified.
  provider_mfa  boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A sign-in sent to the provider, until it comes back: ten minutes. Then, once the provider
-- answered, a code for the admin to trade for the session, for two minutes, once.
CREATE TABLE identity.sso_logins (
  state_hash    bytea       PRIMARY KEY,
  shop_id       uuid        NOT NULL REFERENCES control.shops (id) ON DELETE CASCADE,
  nonce         text        NOT NULL,
  code_verifier text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  -- Set once the provider answered for a member of the shop.
  handoff_hash  bytea       UNIQUE,
  user_id       uuid        REFERENCES identity.users (id) ON DELETE CASCADE,
  redeemed_at   timestamptz
);

CREATE INDEX sso_logins_expiry ON identity.sso_logins (expires_at);

-- The shop whose provider began a session; null for the rest.
ALTER TABLE identity.sessions ADD COLUMN sso_shop_id uuid;

DROP FUNCTION identity.resolve_staff_access(bytea, uuid);

CREATE FUNCTION identity.resolve_staff_access(p_access_token_hash bytea, p_shop_id uuid)
  RETURNS TABLE (
    user_id             uuid,
    session_id          uuid,
    mfa_verified        boolean,
    authenticated_at    timestamptz,
    role                text,
    shop_currency       text,
    support_grant_id    uuid,
    custom_role_id      uuid,
    custom_scopes       text[],
    custom_capabilities text[],
    -- The shop requires its provider, and this session is not one it began (ADR-864).
    sso_required        boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.user_id, s.id, s.mfa_verified_at IS NOT NULL, s.authenticated_at, m.role,
         coalesce(sh.currency, gs.currency), g.id, cr.id, cr.scopes, cr.capabilities,
         coalesce(sso.required, false) AND s.sso_shop_id IS DISTINCT FROM p_shop_id
    FROM identity.sessions s
    JOIN identity.users u ON u.id = s.user_id AND u.status = 'active'
    LEFT JOIN (identity.memberships m
               JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active')
           ON m.user_id = s.user_id AND m.shop_id = p_shop_id AND m.status = 'active'
          AND (m.expires_at IS NULL OR m.expires_at > now())
          -- A session a shop's provider began reaches that shop alone: the shop's owner chose
          -- the provider, and vouches for no other shop its staff work in.
          AND (s.sso_shop_id IS NULL OR s.sso_shop_id = m.shop_id)
    LEFT JOIN identity.custom_roles cr
           ON cr.shop_id = m.shop_id AND cr.id = m.custom_role_id
    LEFT JOIN identity.shop_sso sso ON sso.shop_id = m.shop_id
    -- Hatti's support, in a shop it does not work in, while the owner's grant is open.
    LEFT JOIN (identity.support_agents a
               JOIN identity.support_grants g
                 ON g.shop_id = p_shop_id AND g.ended_at IS NULL AND g.expires_at > now()
               JOIN control.shops gs ON gs.id = g.shop_id AND gs.status = 'active')
           ON a.user_id = s.user_id AND a.status = 'active' AND m.role IS NULL
          AND s.sso_shop_id IS NULL
   WHERE s.access_token_hash = p_access_token_hash
     AND s.revoked_at IS NULL
     AND s.access_expires_at > now()
     AND s.expires_at > now()
$$;

ALTER FUNCTION identity.resolve_staff_access(bytea, uuid) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.resolve_staff_access(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.resolve_staff_access(bytea, uuid) TO hatti_app_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.shop_sso, identity.sso_logins
  TO hatti_identity_role;
