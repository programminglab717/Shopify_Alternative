-- 0272 · Staff's alerts by their custom roles
-- The shop's staff as the worker tells them of its work (ADR-191, ADR-506), with the custom role
-- each holds (ADM-01, ADR-578): its scopes and capabilities, null for a preset's. A custom role's
-- member is told of the work they can do, and no other: a push of a new order needs `write_orders`,
-- of cash remitted `reconcile_payments`. See ADR-581 in docs/architecture/13-decision-log.md.

DROP FUNCTION identity.staff_phones(uuid);

CREATE FUNCTION identity.staff_phones(p_shop_id uuid)
  RETURNS TABLE (user_id uuid, name text, role text, phone text, language text,
                 custom_scopes text[], custom_capabilities text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.name, m.role,
         CASE WHEN u.status = 'active' AND u.phone_verified_at IS NOT NULL THEN u.phone_e164 END,
         u.language, cr.scopes, cr.capabilities
    FROM identity.memberships m
    JOIN identity.users u ON u.id = m.user_id
    JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active'
    LEFT JOIN identity.custom_roles cr ON cr.shop_id = m.shop_id AND cr.id = m.custom_role_id
   WHERE m.shop_id = p_shop_id
     AND m.status = 'active'
     AND (m.expires_at IS NULL OR m.expires_at > now())
     AND p_shop_id = platform.current_shop_id()
   ORDER BY m.created_at, u.id
$$;

ALTER FUNCTION identity.staff_phones(uuid) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.staff_phones(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.staff_phones(uuid) TO hatti_app_role;
