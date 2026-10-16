-- 0213 · Stores taken down
-- Hatti's people take a store down when what shoppers report of it is upheld (TNS-01): the shop is
-- suspended, its storefront shows Hatti's page saying so, its checkout and its staff's sign-ins
-- close as they do for any shop not active, and its owner is told why. Restoring it opens all of
-- them again. Each takedown is kept, with who took it and why, and who restored it. See ADR-461 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE trust.takedowns (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  reason       text        NOT NULL CHECK (reason IN ('never_delivered', 'not_as_described',
                                                       'counterfeit', 'prohibited', 'scam',
                                                       'impersonation', 'other')),
  -- What the owner is told of why, in Hatti's people's words.
  note         text        NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
  taken_by     text        NOT NULL CHECK (char_length(taken_by) BETWEEN 1 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now(),
  restored_at  timestamptz,
  restored_by  text        CHECK (char_length(restored_by) BETWEEN 1 AND 100),
  restore_note text        CHECK (char_length(restore_note) BETWEEN 1 AND 1000),
  PRIMARY KEY (shop_id, id),
  CHECK ((restored_at IS NULL) = (restored_by IS NULL)
     AND (restored_at IS NULL) = (restore_note IS NULL))
);

SELECT platform.enable_tenant_isolation('trust.takedowns');

-- A store is down once at a time.
CREATE UNIQUE INDEX takedowns_open ON trust.takedowns (shop_id) WHERE restored_at IS NULL;
