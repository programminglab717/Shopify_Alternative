-- 0216 · Shops verified by Hatti
-- A shop's owner asks Hatti to verify who runs it (ONB-11): their identity, by their CNIC, then
-- the business, by its NTN, each with photos of the documents. Hatti's people approve or refuse
-- each with why, and may take a verification back. Once decided, the photos are deleted and the
-- CNIC kept only as its last four digits. The storefront shows a shop verified as such (OS-11).
-- See ADR-465 in docs/architecture/13-decision-log.md.

CREATE TABLE trust.verifications (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- What is verified: the person who runs the shop, or the business, which needs the first.
  level        text        NOT NULL CHECK (level IN ('identity', 'business')),
  -- The name on the CNIC, or the business's registered name.
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  -- The CNIC's 13 digits while it waits, and its last four always.
  cnic         text        CHECK (cnic ~ '^\d{13}$'),
  cnic_last4   text        CHECK (cnic_last4 ~ '^\d{4}$'),
  -- The business's NTN as FBR gives it: seven digits and a check digit, or a sole
  -- proprietor's CNIC's 13 digits.
  ntn          text        CHECK (ntn ~ '^(\d{7}-\d|\d{13})$'),
  -- The photos, in storage under the shop's verifications prefix, while it waits:
  -- [{"key", "contentType", "size"}].
  documents    jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(documents) = 'array'),
  status       text        NOT NULL DEFAULT 'waiting'
                           CHECK (status IN ('waiting', 'approved', 'refused', 'revoked')),
  -- The owner who asked, by their user ID.
  asked_by     uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text        CHECK (char_length(decided_by) <= 100),
  -- Why it was refused or taken back, which its owner reads; or a note on its approval.
  answer       text        CHECK (char_length(answer) <= 1000),
  PRIMARY KEY (shop_id, id),
  CHECK ((status = 'waiting') = (decided_at IS NULL)),
  CHECK ((level = 'identity') = (cnic_last4 IS NOT NULL)),
  CHECK ((level = 'business') = (ntn IS NOT NULL)),
  -- The CNIC in full and the photos only while it waits.
  CHECK (status = 'waiting' OR (cnic IS NULL AND documents = '[]'))
);

SELECT platform.enable_tenant_isolation('trust.verifications');

-- One request waiting a shop, and one verification of each level standing.
CREATE UNIQUE INDEX verifications_one_waiting
  ON trust.verifications (shop_id) WHERE status = 'waiting';
CREATE UNIQUE INDEX verifications_one_approved
  ON trust.verifications (shop_id, level) WHERE status = 'approved';
-- Hatti's people's queue, the oldest first, and a shop's own, the newest first.
CREATE INDEX verifications_waiting ON trust.verifications (created_at) WHERE status = 'waiting';
CREATE INDEX verifications_of_shop ON trust.verifications (shop_id, created_at DESC);
