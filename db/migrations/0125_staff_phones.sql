-- 0125 · Staff's numbers for their own alerts (ORD-10, ORD-02)
-- The active members of staff of shop `p_shop_id`, an active shop, by account, name and role, each
-- with the number the account signs in with where it proved it and is not disabled: what staff are
-- told of their own work at (ADR-191). Only for the shop of the transaction asking, and SECURITY
-- DEFINER, so that the worker, which never reads identity's tables, learns no more than this, as
-- with identity.staff_email.
-- See ADR-193 in docs/architecture/13-decision-log.md.

CREATE FUNCTION identity.staff_phones(p_shop_id uuid)
  RETURNS TABLE (user_id uuid, name text, role text, phone text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.name, m.role,
         CASE WHEN u.status = 'active' AND u.phone_verified_at IS NOT NULL THEN u.phone_e164 END
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
