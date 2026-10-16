-- 0212 · Reports of stores
-- Shoppers report a store to Hatti from the link in every store's footer (TNS-01): what is wrong,
-- in their words, and how to reach them if they say. Each report is due a decision from Hatti's
-- people within 48 hours: dismissed, or upheld with what was done. The shop never sees who
-- reported it. See ADR-460 in docs/architecture/13-decision-log.md.

CREATE SCHEMA trust;

GRANT USAGE ON SCHEMA trust TO hatti_app_role, hatti_system_role;

CREATE TABLE trust.reports (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  reason       text        NOT NULL CHECK (reason IN ('never_delivered', 'not_as_described',
                                                       'counterfeit', 'prohibited', 'scam',
                                                       'impersonation', 'other')),
  details      text        NOT NULL CHECK (char_length(details) BETWEEN 1 AND 2000),
  -- How to reach the shopper, if they gave it: a Pakistani mobile, as E.164.
  phone        text        CHECK (phone ~ '^\+92\d{10}$'),
  order_name   text        CHECK (char_length(order_name) <= 40),
  -- Where the shopper was, and a hash of their address with the shop's, to see one person
  -- reporting the same store often.
  page_url     text        CHECK (char_length(page_url) <= 500),
  client_hash  text        CHECK (char_length(client_hash) <= 64),
  language     text        NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ur')),
  status       text        NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'dismissed', 'upheld')),
  -- The decision Hatti owes it by: 48 hours after it came.
  due_at       timestamptz NOT NULL,
  decided_at   timestamptz,
  decided_by   text        CHECK (char_length(decided_by) <= 100),
  decision     text        CHECK (char_length(decision) <= 1000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CHECK ((status = 'open') = (decided_at IS NULL))
);

SELECT platform.enable_tenant_isolation('trust.reports');

-- Hatti's people's queue: those open, the soonest due first.
CREATE INDEX reports_open ON trust.reports (due_at) WHERE status = 'open';
CREATE INDEX reports_of_shop ON trust.reports (shop_id, created_at DESC);
