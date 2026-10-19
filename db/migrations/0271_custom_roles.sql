-- 0271 · Custom roles
-- A shop's own staff roles (ADM-01, ADR-578), beside the presets: each made from a preset other
-- than the owner's, named as the shop likes, with some of its preset's scopes and some of its
-- capabilities, what staff may do beyond their scopes, such as seeing customers' numbers whole or
-- exporting orders. A custom role never holds more than its preset. A member of staff, or an
-- invitation, in a custom role keeps its preset as their role, which says the rest, such as
-- whether they need a second factor; the role's scopes and capabilities are read with their
-- session's on each request, so a change to them counts from the next one. A custom role a member
-- of staff or an invitation waiting holds is not deleted. Like memberships, custom roles are
-- identity's, out of the request-serving login's reach; identity.resolve_staff_access reads them.
-- See ADR-578 in docs/architecture/13-decision-log.md.

CREATE TABLE identity.custom_roles (
  id           uuid        PRIMARY KEY,
  shop_id      uuid        NOT NULL REFERENCES control.shops (id),
  -- "Packer, no labels": unique in the shop whatever its case.
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  -- The preset it was made from, for good: its members' role.
  based_on     text        NOT NULL
                           CHECK (based_on IN ('manager', 'confirmation_agent', 'packer',
                                               'marketer', 'accountant')),
  -- Access scopes, within its preset's: one of them, or the read of a resource it writes.
  scopes       text[]      NOT NULL DEFAULT '{}',
  -- Capabilities, some of its preset's.
  capabilities text[]      NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id, based_on)
);

CREATE UNIQUE INDEX custom_roles_name_idx ON identity.custom_roles (shop_id, lower(name));

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.custom_roles TO hatti_identity_role;

-- A member's custom role is their shop's, and their role its preset: never the owner's.
ALTER TABLE identity.memberships
  ADD COLUMN custom_role_id uuid,
  ADD CONSTRAINT memberships_custom_role_fk FOREIGN KEY (shop_id, custom_role_id, role)
    REFERENCES identity.custom_roles (shop_id, id, based_on);

CREATE INDEX memberships_custom_role_idx ON identity.memberships (shop_id, custom_role_id)
  WHERE custom_role_id IS NOT NULL;

-- So is an invitation's. One accepted, taken back or expired forgets a custom role deleted since.
ALTER TABLE identity.invitations
  ADD COLUMN custom_role_id uuid,
  ADD CONSTRAINT invitations_custom_role_fk FOREIGN KEY (shop_id, custom_role_id, role)
    REFERENCES identity.custom_roles (shop_id, id, based_on) ON DELETE SET NULL (custom_role_id);

CREATE INDEX invitations_custom_role_idx ON identity.invitations (shop_id, custom_role_id)
  WHERE custom_role_id IS NOT NULL;

-- A staff session's access to a shop, with the custom role its membership holds: its scopes and
-- capabilities, null for a preset's.
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
    custom_capabilities text[]
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.user_id, s.id, s.mfa_verified_at IS NOT NULL, s.authenticated_at, m.role,
         coalesce(sh.currency, gs.currency), g.id, cr.id, cr.scopes, cr.capabilities
    FROM identity.sessions s
    JOIN identity.users u ON u.id = s.user_id AND u.status = 'active'
    LEFT JOIN (identity.memberships m
               JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active')
           ON m.user_id = s.user_id AND m.shop_id = p_shop_id AND m.status = 'active'
          AND (m.expires_at IS NULL OR m.expires_at > now())
    LEFT JOIN identity.custom_roles cr
           ON cr.shop_id = m.shop_id AND cr.id = m.custom_role_id
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

ALTER FUNCTION identity.resolve_staff_access(bytea, uuid) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.resolve_staff_access(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.resolve_staff_access(bytea, uuid) TO hatti_app_role;

-- A member of staff's email, as the worker sends them scheduled exports (ADR-183), with their
-- custom role's capabilities, null for a preset's: the export goes only to whom may export.
DROP FUNCTION identity.staff_email(uuid, uuid);

CREATE FUNCTION identity.staff_email(p_user_id uuid, p_shop_id uuid)
  RETURNS TABLE (email text, name text, role text, language text, capabilities text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.email, u.name, m.role, u.language, cr.capabilities
    FROM identity.users u
    JOIN identity.memberships m
      ON m.user_id = u.id AND m.shop_id = p_shop_id AND m.status = 'active'
     AND (m.expires_at IS NULL OR m.expires_at > now())
    JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active'
    LEFT JOIN identity.custom_roles cr ON cr.shop_id = m.shop_id AND cr.id = m.custom_role_id
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
