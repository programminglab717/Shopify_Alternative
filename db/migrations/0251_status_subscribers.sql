-- 0251 · The status page's subscribers
-- Anyone may ask from /status to be emailed what Hatti says of incidents and maintenance (BIL-06):
-- confirmed by a link emailed to the address first, and ended by a link in every email. The
-- worker sends both, each once. See ADR-535 in docs/architecture/13-decision-log.md.

CREATE TABLE trust.status_subscribers (
  id                uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  -- As given, in lower case.
  email             text        NOT NULL UNIQUE
                                CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  -- The links' secret: to confirm, and to stop. It gives no more than that, so it is kept as is
  -- for the worker to put in each email.
  token             text        NOT NULL UNIQUE CHECK (char_length(token) >= 32),
  confirmed_at      timestamptz,
  -- When the link to confirm was last asked for, and emailed.
  asked_at          timestamptz NOT NULL DEFAULT now(),
  confirm_mailed_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- What the worker emails next: addresses to confirm.
CREATE INDEX status_subscribers_to_confirm ON trust.status_subscribers (asked_at)
  WHERE confirmed_at IS NULL AND confirm_mailed_at IS NULL;

-- The core's pages take, confirm and stop addresses; the worker takes what to email.
GRANT SELECT, INSERT, UPDATE, DELETE ON trust.status_subscribers TO hatti_app_role, hatti_system_role;

-- Each update is emailed to the subscribers once; those already posted are not emailed now.
ALTER TABLE trust.incident_updates ADD COLUMN mailed_at timestamptz;
UPDATE trust.incident_updates SET mailed_at = posted_at;
CREATE INDEX incident_updates_to_mail ON trust.incident_updates (posted_at) WHERE mailed_at IS NULL;
