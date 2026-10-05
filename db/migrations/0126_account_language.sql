-- 0126 · An account's own language (ONB-01, ADM-02)
-- English or Urdu: the language Hatti's emails and messages to the account's owner are in, as
-- they chose it, or as they signed up in. Staff's emails and numbers, which the worker reads for
-- the shop of its transaction alone, say it too, for what it sends them.
-- See ADR-194 in docs/architecture/13-decision-log.md.

ALTER TABLE identity.users
  ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ur'));

DROP FUNCTION identity.staff_email(uuid, uuid);

CREATE FUNCTION identity.staff_email(p_user_id uuid, p_shop_id uuid)
  RETURNS TABLE (email text, name text, role text, language text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.email, u.name, m.role, u.language
    FROM identity.users u
    JOIN identity.memberships m
      ON m.user_id = u.id AND m.shop_id = p_shop_id AND m.status = 'active'
    JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active'
   WHERE u.id = p_user_id
     AND u.status = 'active'
     AND u.email IS NOT NULL
     AND u.email_verified_at IS NOT NULL
     AND p_shop_id = platform.current_shop_id()
     AND NOT EXISTS (SELECT 1 FROM identity.email_suppressions s WHERE s.email = u.email)
$$;

ALTER FUNCTION identity.staff_email(uuid, uuid) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.staff_email(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.staff_email(uuid, uuid) TO hatti_app_role;

DROP FUNCTION identity.staff_phones(uuid);

CREATE FUNCTION identity.staff_phones(p_shop_id uuid)
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
     AND p_shop_id = platform.current_shop_id()
   ORDER BY m.created_at, u.id
$$;

ALTER FUNCTION identity.staff_phones(uuid) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.staff_phones(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.staff_phones(uuid) TO hatti_app_role;
