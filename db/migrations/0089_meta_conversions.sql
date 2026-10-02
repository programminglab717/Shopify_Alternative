-- 0089 · Meta's conversions API
-- Orders reach the ads that brought them (MKT-10): a shop connects its Meta dataset, and the
-- worker sends each order placed through checkout to Meta's conversions API as it is placed,
-- confirmed and delivered, the moment the shop chooses as its Purchase. Each moment waits in
-- marketing.conversions until it is sent, or until Meta's seven days for it are up.
-- See ADR-143 in docs/architecture/13-decision-log.md.

CREATE SCHEMA marketing;

GRANT USAGE ON SCHEMA marketing TO hatti_app_role, hatti_system_role;

-- The shop's Meta dataset, its pixel, and the access token Events Manager gave it.
CREATE TABLE marketing.meta_settings (
  shop_id         uuid        PRIMARY KEY,
  pixel_id        text        NOT NULL CHECK (pixel_id ~ '^[0-9]{6,20}$'),
  -- Sealed for the shop alone, and never shown again.
  access_token    text        NOT NULL,
  -- Its last four characters, to tell tokens apart by.
  token_hint      text        NOT NULL CHECK (char_length(token_hint) = 4),
  -- Events Manager's code for test events, while the shop tries them out.
  test_event_code text        CHECK (test_event_code ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- Which of an order's moments is Meta's Purchase; the others go by names of their own.
  purchase_at     text        NOT NULL DEFAULT 'placed'
                              CHECK (purchase_at IN ('placed', 'confirmed', 'delivered')),
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('marketing.meta_settings');

-- Each moment of an order to send to an ad platform: when it happened, and how sending it went.
CREATE TABLE marketing.conversions (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT platform.uuidv7(),
  platform        text        NOT NULL CHECK (platform IN ('meta')),
  order_id        uuid        NOT NULL,
  moment          text        NOT NULL CHECK (moment IN ('placed', 'confirmed', 'delivered')),
  occurred_at     timestamptz NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'sent', 'failed', 'expired', 'skipped')),
  -- The name it went by once sent: Purchase, or its moment's own.
  event_name      text        CHECK (char_length(event_name) <= 50),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  -- What the platform said last: why it refused it, or the trace of the request that took it.
  error           text        CHECK (char_length(error) <= 1000),
  trace_id        text        CHECK (char_length(trace_id) <= 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, platform, order_id, moment),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('marketing.conversions');

-- What the sender sends next, whatever the shop.
CREATE INDEX conversions_due ON marketing.conversions (next_attempt_at) WHERE status = 'pending';
-- The shop's latest first, as the Admin API lists them.
CREATE INDEX conversions_latest ON marketing.conversions (shop_id, created_at DESC, id DESC);
