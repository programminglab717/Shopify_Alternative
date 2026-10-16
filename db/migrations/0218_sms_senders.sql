-- 0218 · Shops' own SMS sender names
-- A shop asks for its SMS to come from a name of its own (MKT-02), such as ZARI, rather than
-- Hatti's shared sender. Operators register such names in about two weeks, so Hatti's people
-- approve or refuse each with why, once the shop is verified (ONB-11), and may take one back.
-- Once approved, its customers' SMS go from it; what Hatti tells the shop itself does not.
-- See ADR-469 in docs/architecture/13-decision-log.md.

CREATE TABLE messaging.sms_senders (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- What phones show the SMS from: 3 to 11 letters, digits and single spaces, a letter among
  -- them, as operators register alphanumeric senders.
  name         text        NOT NULL CHECK (name ~ '^[A-Za-z0-9]( ?[A-Za-z0-9]){2,10}$'
                                           AND name ~ '[A-Za-z]'),
  status       text        NOT NULL DEFAULT 'waiting'
                           CHECK (status IN ('waiting', 'approved', 'refused', 'withdrawn',
                                             'replaced', 'revoked')),
  -- Who asked: a member of staff by their user ID, or an app by its token's.
  asked_by     uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text        CHECK (char_length(decided_by) <= 100),
  -- Why it was refused or taken back, which the shop reads; or a note on its approval.
  answer       text        CHECK (char_length(answer) <= 1000),
  PRIMARY KEY (shop_id, id),
  CHECK ((status = 'waiting') = (decided_at IS NULL))
);

SELECT platform.enable_tenant_isolation('messaging.sms_senders');

-- One request waiting a shop, and one name in use.
CREATE UNIQUE INDEX sms_senders_one_waiting
  ON messaging.sms_senders (shop_id) WHERE status = 'waiting';
CREATE UNIQUE INDEX sms_senders_one_approved
  ON messaging.sms_senders (shop_id) WHERE status = 'approved';
-- A name sends for one shop alone, as operators register it.
CREATE UNIQUE INDEX sms_senders_name_taken
  ON messaging.sms_senders (lower(name)) WHERE status = 'approved';
-- Hatti's people's queue, the oldest first, and a shop's own, the newest first.
CREATE INDEX sms_senders_waiting ON messaging.sms_senders (created_at) WHERE status = 'waiting';
CREATE INDEX sms_senders_of_shop ON messaging.sms_senders (shop_id, created_at DESC);
