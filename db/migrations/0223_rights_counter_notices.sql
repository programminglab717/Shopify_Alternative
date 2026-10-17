-- 0223 · Counter-notices to rights complaints
-- The notice of listings taken down for a rights complaint (ADR-475) carries a link of its own,
-- kept here only as its SHA-256 digest: its page shows the store's owner the complaint and takes
-- their sworn counter-notice, once. Hatti's people refuse it with why, or let the listings go,
-- which upholds it. See ADR-476 in docs/architecture/13-decision-log.md.

ALTER TABLE trust.rights_complaints
  ADD COLUMN link_digest         bytea       CHECK (length(link_digest) = 32),
  -- The owner's side, the name they signed it with, and when.
  ADD COLUMN counter_words       text        CHECK (char_length(counter_words) BETWEEN 1 AND 2000),
  ADD COLUMN counter_signature   text        CHECK (char_length(counter_signature) BETWEEN 1 AND 200),
  ADD COLUMN countered_at        timestamptz,
  ADD COLUMN counter_status      text        CHECK (counter_status IN ('open', 'refused', 'upheld')),
  ADD COLUMN counter_answered_at timestamptz,
  ADD COLUMN counter_answered_by text        CHECK (char_length(counter_answered_by) BETWEEN 1 AND 100),
  -- Hatti's answer, which the link's page shows the owner.
  ADD COLUMN counter_answer      text        CHECK (char_length(counter_answer) BETWEEN 1 AND 1000),
  -- When Hatti's people let the listings go, who, and why.
  ADD COLUMN released_at         timestamptz,
  ADD COLUMN released_by         text        CHECK (char_length(released_by) BETWEEN 1 AND 100),
  ADD COLUMN release_note        text        CHECK (char_length(release_note) BETWEEN 1 AND 1000),
  ADD CHECK ((counter_words IS NULL) = (countered_at IS NULL)
         AND (counter_words IS NULL) = (counter_signature IS NULL)
         AND (counter_words IS NULL) = (counter_status IS NULL)),
  ADD CHECK ((counter_answered_at IS NULL) = (counter_answered_by IS NULL)
         AND (counter_answered_at IS NULL) = (counter_answer IS NULL)),
  ADD CHECK ((released_at IS NULL) = (released_by IS NULL)
         AND (released_at IS NULL) = (release_note IS NULL)),
  ADD CHECK (link_digest IS NULL OR status = 'upheld'),
  ADD CHECK (released_at IS NULL OR status = 'upheld');

CREATE UNIQUE INDEX rights_complaints_link ON trust.rights_complaints (link_digest)
  WHERE link_digest IS NOT NULL;

-- Hatti's people's queue of counter-notices, the oldest first.
CREATE INDEX rights_counters_waiting ON trust.rights_complaints (countered_at)
  WHERE counter_status = 'open';

-- The complaint a link's secret belongs to, found without knowing the shop: the core's requests
-- have no system login.
CREATE FUNCTION trust.resolve_rights_link(p_digest bytea)
  RETURNS TABLE (shop_id uuid, complaint_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.shop_id, c.id FROM trust.rights_complaints c WHERE c.link_digest = p_digest
$$;

ALTER FUNCTION trust.resolve_rights_link(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION trust.resolve_rights_link(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trust.resolve_rights_link(bytea) TO hatti_app_role;
