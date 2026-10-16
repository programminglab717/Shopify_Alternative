-- 0221 · Rights complaints
-- Owners of a trademark or copyright, or someone acting for them, tell Hatti that listings on a
-- store infringe it (TNS-04): from Hatti's page on the store itself, naming the listings by their
-- addresses, saying what right and whose, and swearing in good faith that it is so. Each is due a
-- decision from Hatti's people within 48 hours: dismissed, or upheld with what was done. See
-- ADR-474 in docs/architecture/13-decision-log.md.

CREATE TABLE trust.rights_complaints (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- The right: a trademark, a copyright, or goods passed off as a brand's own.
  kind             text        NOT NULL CHECK (kind IN ('trademark', 'copyright', 'counterfeit')),
  -- Whose right, and its registration if it has one (IPO-Pakistan's number).
  rights_owner     text        NOT NULL CHECK (char_length(rights_owner) BETWEEN 1 AND 200),
  registration     text        CHECK (char_length(registration) BETWEEN 1 AND 100),
  -- Who complains, and whether as the owner or acting for them.
  complainant      text        NOT NULL CHECK (char_length(complainant) BETWEEN 1 AND 200),
  acting_as        text        NOT NULL CHECK (acting_as IN ('owner', 'agent')),
  email            text        NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  phone            text        CHECK (phone ~ '^\+92\d{10}$'),
  -- The listings, as the store showed them: [{ "id", "title", "url" }], 1 to 20.
  listings         jsonb       NOT NULL CHECK (jsonb_typeof(listings) = 'array'
                                               AND jsonb_array_length(listings) BETWEEN 1 AND 20),
  details          text        NOT NULL CHECK (char_length(details) BETWEEN 1 AND 2000),
  -- The complainant's name typed under the good-faith statement, and when.
  signature        text        NOT NULL CHECK (char_length(signature) BETWEEN 1 AND 200),
  sworn_at         timestamptz NOT NULL,
  client_hash      text        CHECK (char_length(client_hash) <= 64),
  language         text        NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ur')),
  status           text        NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open', 'dismissed', 'upheld')),
  due_at           timestamptz NOT NULL,
  decided_at       timestamptz,
  decided_by       text        CHECK (char_length(decided_by) <= 100),
  decision         text        CHECK (char_length(decision) <= 1000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CHECK ((status = 'open') = (decided_at IS NULL))
);

SELECT platform.enable_tenant_isolation('trust.rights_complaints');

-- Hatti's people's queue: those open, the soonest due first.
CREATE INDEX rights_complaints_open ON trust.rights_complaints (due_at) WHERE status = 'open';
CREATE INDEX rights_complaints_of_shop ON trust.rights_complaints (shop_id, created_at DESC);
