-- 0238 · Support requests
-- A shop asks Hatti's people for help from its admin (BIL-05): what it is about, in its own words,
-- and whether to call back, at what number. Hatti's people answer each from their own tool, in
-- order of the shop's plan's priority and then of age; the admin shows the answer. On WhatsApp or
-- by phone, a shop reaches them as its plan allows; a request is kept either way.
-- See ADR-508 in docs/architecture/13-decision-log.md.

CREATE TABLE billing.support_requests (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  topic        text        NOT NULL CHECK (topic IN ('orders', 'payments', 'couriers', 'store',
                                                     'billing', 'account', 'other')),
  message      text        NOT NULL CHECK (char_length(message) BETWEEN 10 AND 2000),
  -- The language the shop wrote in, which the answer is in.
  language     text        NOT NULL CHECK (language IN ('en', 'ur')),
  -- A Pakistani mobile, E.164, to call back at; null for no call.
  call_back    text        CHECK (call_back ~ '^\+923[0-9]{9}$'),
  -- The shop's plan when it asked, which sets how soon it is answered.
  plan         text        NOT NULL CHECK (plan IN ('free', 'starter', 'growth', 'pro')),
  priority     smallint    NOT NULL CHECK (priority BETWEEN 1 AND 3),
  -- The member of staff who asked, by their user ID.
  opened_by    uuid        NOT NULL,
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  answer       text        CHECK (char_length(answer) BETWEEN 1 AND 4000),
  answered_by  text        CHECK (char_length(answered_by) BETWEEN 1 AND 80),
  answered_at  timestamptz,
  closed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CHECK ((status = 'open') = (answer IS NULL AND closed_at IS NULL) OR status = 'closed'),
  CHECK ((answer IS NULL) = (answered_at IS NULL) AND (answer IS NULL) = (answered_by IS NULL))
);

SELECT platform.enable_tenant_isolation('billing.support_requests');

CREATE INDEX support_requests_of_shop ON billing.support_requests (shop_id, created_at DESC);
-- What Hatti's people answer first: the most urgent, then the oldest.
CREATE INDEX support_requests_open ON billing.support_requests (priority, created_at)
  WHERE status = 'open';
