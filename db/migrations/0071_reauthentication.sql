-- Re-authentication for sensitive actions (ADR-103): a session keeps when its user last proved
-- who they are, by signing in or by confirming it since. Staff's sensitive actions, such as
-- letting staff go or giving out customers' data, need that to be recent.

ALTER TABLE identity.sessions ADD COLUMN authenticated_at timestamptz;
UPDATE identity.sessions SET authenticated_at = created_at;
ALTER TABLE identity.sessions
  ALTER COLUMN authenticated_at SET NOT NULL,
  ALTER COLUMN authenticated_at SET DEFAULT now();

-- A passkey also confirms who is at a session, besides being added or signing in alone.
ALTER TABLE identity.passkey_challenges
  DROP CONSTRAINT passkey_challenges_purpose_check,
  DROP CONSTRAINT passkey_challenges_check,
  ADD CONSTRAINT passkey_challenges_purpose_check
    CHECK (purpose IN ('register', 'sign_in', 'reauthenticate')),
  -- Only signing in comes before anyone is known.
  ADD CONSTRAINT passkey_challenges_user_check CHECK ((purpose = 'sign_in') = (user_id IS NULL));

-- The request path learns when the session's user last proved who they are.
DROP FUNCTION identity.resolve_staff_access(bytea, uuid);

CREATE FUNCTION identity.resolve_staff_access(p_access_token_hash bytea, p_shop_id uuid)
  RETURNS TABLE (
    user_id          uuid,
    session_id       uuid,
    mfa_verified     boolean,
    authenticated_at timestamptz,
    role             text,
    shop_currency    text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.user_id, s.id, s.mfa_verified_at IS NOT NULL, s.authenticated_at, m.role, sh.currency
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
GRANT EXECUTE ON FUNCTION identity.resolve_staff_access(bytea, uuid) TO hatti_app_role;
