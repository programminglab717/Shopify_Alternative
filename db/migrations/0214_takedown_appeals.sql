-- 0214 · Appeals of stores taken down
-- A store's owner can't sign in while Hatti has it down (ADR-461), so the notice telling them
-- carries a link of its own, kept here only as its SHA-256 digest: its page says why the store is
-- down, takes the owner's side of it, and shows Hatti's answer. One appeal is open at a time and
-- three a takedown at most; Hatti's people refuse one with why, or restore the store, which
-- upholds it. See ADR-462 in docs/architecture/13-decision-log.md.

ALTER TABLE trust.takedowns ADD COLUMN appeal_digest bytea CHECK (length(appeal_digest) = 32);

CREATE UNIQUE INDEX takedowns_appeal ON trust.takedowns (appeal_digest)
  WHERE appeal_digest IS NOT NULL;

CREATE TABLE trust.appeals (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  takedown_id  uuid        NOT NULL,
  -- The owner's side, in their words.
  words        text        NOT NULL CHECK (char_length(words) BETWEEN 1 AND 2000),
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'refused', 'upheld')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  answered_by  text        CHECK (char_length(answered_by) BETWEEN 1 AND 100),
  -- Hatti's answer, which the appeal's page shows the owner.
  answer       text        CHECK (char_length(answer) BETWEEN 1 AND 1000),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, takedown_id) REFERENCES trust.takedowns (shop_id, id),
  CHECK ((status = 'open') = (answered_at IS NULL)
     AND (answered_at IS NULL) = (answered_by IS NULL)
     AND (answered_at IS NULL) = (answer IS NULL))
);

SELECT platform.enable_tenant_isolation('trust.appeals');

-- One open at a time; Hatti's people's queue, the oldest first.
CREATE UNIQUE INDEX appeals_open ON trust.appeals (takedown_id) WHERE status = 'open';
CREATE INDEX appeals_waiting ON trust.appeals (created_at) WHERE status = 'open';

-- The takedown an appeal link's secret belongs to, found without knowing the shop: the core's
-- requests have no system login. Whatever the shop's status, as its store is down.
CREATE FUNCTION trust.resolve_appeal_link(p_digest bytea)
  RETURNS TABLE (shop_id uuid, takedown_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.shop_id, t.id FROM trust.takedowns t WHERE t.appeal_digest = p_digest
$$;

ALTER FUNCTION trust.resolve_appeal_link(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION trust.resolve_appeal_link(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trust.resolve_appeal_link(bytea) TO hatti_app_role;
