-- 0419 · A single sign-on domain gone missing is told to its shop (ADM-09)
-- The worker tells a shop on WhatsApp and by email the first time a proved domain's record is
-- found gone (ADR-938): it now learns which shop's the domain is, and whether it was missing
-- already, from the function that gives it the domains due a look. See ADR-938 in
-- docs/architecture/13-decision-log.md.

DROP FUNCTION identity.sso_domains_due(timestamptz, integer);

CREATE FUNCTION identity.sso_domains_due(p_before timestamptz, p_limit integer)
  RETURNS TABLE (domain text, proof_token text, shop_id uuid, missing_since timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.domain, s.proof_token, d.shop_id, d.missing_since
    FROM identity.sso_domains d
    JOIN identity.shop_sso s ON s.shop_id = d.shop_id
   WHERE d.checked_at <= p_before
   ORDER BY d.checked_at, d.domain
   LIMIT p_limit
$$;
ALTER FUNCTION identity.sso_domains_due(timestamptz, integer) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.sso_domains_due(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.sso_domains_due(timestamptz, integer) TO hatti_app_role;
