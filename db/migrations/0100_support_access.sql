-- 0100 · Support access
-- Hatti's support looks at a shop only while its owner allows it (ADM-08): for as long as the
-- owner chooses, a day at most, reading alone, each of its requests on the shop's audit log. Its
-- agents are Hatti's own people, each signed in to their own account with a second factor; the
-- owner or a manager ends the access at any time. See ADR-156 in
-- docs/architecture/13-decision-log.md.

-- Hatti's own support agents, added and removed by Hatti.
CREATE TABLE identity.support_agents (
  user_id    uuid        PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  -- A removed agent looks at nothing more.
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Each time a shop's owner let Hatti's support look.
CREATE TABLE identity.support_grants (
  id         uuid        PRIMARY KEY,
  shop_id    uuid        NOT NULL REFERENCES control.shops (id),
  -- The owner who allowed it.
  granted_by uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  -- What Hatti's support may do: look.
  access     text        NOT NULL DEFAULT 'read' CHECK (access IN ('read')),
  -- What it is for, as the owner noted it: "Order #1043 won't ship".
  note       text        CHECK (char_length(note) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- When it stopped: ended by the owner or a manager, a new grant in its place, or its time up.
  ended_at   timestamptz,
  ended_by   uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 day'),
  CHECK (ended_at IS NULL OR ended_at >= created_at),
  CHECK (ended_by IS NULL OR ended_at IS NOT NULL)
);

-- One grant open a shop: a new one ends the last first.
CREATE UNIQUE INDEX support_grants_open ON identity.support_grants (shop_id)
  WHERE ended_at IS NULL;
CREATE INDEX support_grants_shop_idx ON identity.support_grants (shop_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON identity.support_agents, identity.support_grants
  TO hatti_identity_role;

-- A staff session's access to a shop: its role there, or Hatti's support under the grant open now.
DROP FUNCTION identity.resolve_staff_access(bytea, uuid);

CREATE FUNCTION identity.resolve_staff_access(p_access_token_hash bytea, p_shop_id uuid)
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

-- What Hatti's support looked at goes on the shop's audit log, as it.
ALTER TABLE platform.audit_log DROP CONSTRAINT audit_log_actor_kind_check;
ALTER TABLE platform.audit_log
  ADD CONSTRAINT audit_log_actor_kind_check CHECK (actor_kind IN ('app', 'staff', 'support'));
