-- 0418 · Single sign-on domains checked again (ADM-09)
-- A domain proved a shop's through DNS (ADR-919) is looked up again each day: one whose record
-- is gone is said so in the admin, and three days on it is no longer proved the shop's, so a
-- domain sold or given up stops sending its sign-ins there. A lookup that fails changes nothing.
-- See ADR-934 in docs/architecture/13-decision-log.md.

ALTER TABLE identity.sso_domains
  ADD COLUMN checked_at    timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN missing_since timestamptz;

CREATE INDEX sso_domains_checked ON identity.sso_domains (checked_at);

-- The worker, with the app login, sees no more than this: the domains due a look, the record each
-- should show, and what it found.
CREATE FUNCTION identity.sso_domains_due(p_before timestamptz, p_limit integer)
  RETURNS TABLE (domain text, proof_token text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.domain, s.proof_token
    FROM identity.sso_domains d
    JOIN identity.shop_sso s ON s.shop_id = d.shop_id
   WHERE d.checked_at <= p_before
   ORDER BY d.checked_at, d.domain
   LIMIT p_limit
$$;
ALTER FUNCTION identity.sso_domains_due(timestamptz, integer) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.sso_domains_due(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.sso_domains_due(timestamptz, integer) TO hatti_app_role;

-- What a look at `p_domain` at `p_at` found: its record (true), none (false), or no answer
-- (null). Missing `p_grace` and more, the domain is no longer proved its shop's. What came of it.
CREATE FUNCTION identity.sso_domain_checked(
  p_domain text, p_at timestamptz, p_found boolean, p_grace interval
)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_missing timestamptz;
BEGIN
  SELECT missing_since INTO v_missing FROM identity.sso_domains
   WHERE domain = p_domain FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unproved';
  END IF;
  IF p_found IS NULL THEN
    UPDATE identity.sso_domains SET checked_at = p_at WHERE domain = p_domain;
    RETURN 'unanswered';
  END IF;
  IF p_found THEN
    UPDATE identity.sso_domains SET checked_at = p_at, missing_since = NULL
     WHERE domain = p_domain;
    RETURN 'proved';
  END IF;
  IF p_at - coalesce(v_missing, p_at) >= p_grace THEN
    DELETE FROM identity.sso_domains WHERE domain = p_domain;
    RETURN 'unproved';
  END IF;
  UPDATE identity.sso_domains SET checked_at = p_at, missing_since = coalesce(v_missing, p_at)
   WHERE domain = p_domain;
  RETURN 'missing';
END
$$;
ALTER FUNCTION identity.sso_domain_checked(text, timestamptz, boolean, interval)
  OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.sso_domain_checked(text, timestamptz, boolean, interval)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.sso_domain_checked(text, timestamptz, boolean, interval)
  TO hatti_app_role;
