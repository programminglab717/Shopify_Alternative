-- Collaborators (ADM-07, ADR-487): staff invited for some days alone, such as an agency's, whose
-- membership ends by itself. An invitation may say for how many days its access lasts, 1 to 90;
-- accepted, the membership it makes ends then.

ALTER TABLE identity.invitations
  ADD COLUMN access_days integer CHECK (access_days BETWEEN 1 AND 90);

ALTER TABLE identity.memberships
  ADD COLUMN expires_at timestamptz,
  ADD CONSTRAINT memberships_owner_for_good CHECK (expires_at IS NULL OR role <> 'owner');

CREATE INDEX memberships_expires_idx ON identity.memberships (expires_at)
  WHERE expires_at IS NOT NULL;

-- A membership past its end gives no access, before the worker takes it away.
CREATE OR REPLACE FUNCTION identity.resolve_staff_access(p_access_token_hash bytea, p_shop_id uuid)
  RETURNS TABLE (
    user_id          uuid,
    session_id       uuid,
    mfa_verified     boolean,
    authenticated_at timestamptz,
    role             text,
    shop_currency    text,
    support_grant_id uuid
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.user_id, s.id, s.mfa_verified_at IS NOT NULL, s.authenticated_at, m.role,
         coalesce(sh.currency, gs.currency), g.id
    FROM identity.sessions s
    JOIN identity.users u ON u.id = s.user_id AND u.status = 'active'
    LEFT JOIN (identity.memberships m
               JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active')
           ON m.user_id = s.user_id AND m.shop_id = p_shop_id AND m.status = 'active'
          AND (m.expires_at IS NULL OR m.expires_at > now())
    -- Hatti's support, in a shop it does not work in, while the owner's grant is open.
    LEFT JOIN (identity.support_agents a
               JOIN identity.support_grants g
                 ON g.shop_id = p_shop_id AND g.ended_at IS NULL AND g.expires_at > now()
               JOIN control.shops gs ON gs.id = g.shop_id AND gs.status = 'active')
           ON a.user_id = s.user_id AND a.status = 'active' AND m.role IS NULL
   WHERE s.access_token_hash = p_access_token_hash
     AND s.revoked_at IS NULL
     AND s.access_expires_at > now()
     AND s.expires_at > now()
$$;

-- The worker ends memberships past their end, a few at a time: how many it ended.
CREATE FUNCTION identity.end_expired_memberships(p_limit integer)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH due AS (
    SELECT user_id, shop_id FROM identity.memberships
     WHERE expires_at <= now()
     ORDER BY expires_at
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  ), ended AS (
    DELETE FROM identity.memberships m
     USING due
     WHERE m.user_id = due.user_id AND m.shop_id = due.shop_id
    RETURNING m.user_id
  )
  SELECT count(*)::integer FROM ended
$$;
ALTER FUNCTION identity.end_expired_memberships(integer) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.end_expired_memberships(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.end_expired_memberships(integer) TO hatti_app_role;

-- Nor is a collaborator past their end told of the shop's work, before the worker ends them.
CREATE OR REPLACE FUNCTION identity.staff_phones(p_shop_id uuid)
  RETURNS TABLE (user_id uuid, name text, role text, phone text, language text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.name, m.role,
         CASE WHEN u.status = 'active' AND u.phone_verified_at IS NOT NULL THEN u.phone_e164 END,
         u.language
    FROM identity.memberships m
    JOIN identity.users u ON u.id = m.user_id
    JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active'
   WHERE m.shop_id = p_shop_id
     AND m.status = 'active'
     AND (m.expires_at IS NULL OR m.expires_at > now())
     AND p_shop_id = platform.current_shop_id()
   ORDER BY m.created_at, u.id
$$;

CREATE OR REPLACE FUNCTION identity.staff_email(p_user_id uuid, p_shop_id uuid)
  RETURNS TABLE (email text, name text, role text, language text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.email, u.name, m.role, u.language
    FROM identity.users u
    JOIN identity.memberships m
      ON m.user_id = u.id AND m.shop_id = p_shop_id AND m.status = 'active'
     AND (m.expires_at IS NULL OR m.expires_at > now())
    JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active'
   WHERE u.id = p_user_id
     AND u.status = 'active'
     AND u.email IS NOT NULL
     AND u.email_verified_at IS NOT NULL
     AND p_shop_id = platform.current_shop_id()
     AND NOT EXISTS (SELECT 1 FROM identity.email_suppressions s WHERE s.email = u.email)
$$;
