-- 0187 · Webhooks (DEV-03)
-- A custom app subscribes to topics of the shop's events, each at an https address of its own.
-- The worker turns each event into a delivery for every subscription to its topic whose app may
-- read what it names, and posts it, signed with the app's secret, retrying with backoff for two
-- days; each try's outcome is kept for 30 days. See ADR-397 in docs/architecture/13-decision-log.md.

CREATE TABLE apps.webhook_subscriptions (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- The app: its access token.
  app_id     uuid        NOT NULL,
  -- As Shopify names them: "orders/create".
  topic      text        NOT NULL CHECK (topic ~ '^[a-z_]+/[a-z_]+$'),
  uri        text        NOT NULL CHECK (length(uri) BETWEEN 9 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, app_id) REFERENCES apps.access_tokens (shop_id, id) ON DELETE CASCADE,
  UNIQUE (shop_id, app_id, topic, uri)
);
CREATE INDEX webhook_subscriptions_topic_idx ON apps.webhook_subscriptions (shop_id, topic);
SELECT platform.enable_tenant_isolation('apps.webhook_subscriptions');

CREATE TABLE apps.webhook_deliveries (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT platform.uuidv7(),
  subscription_id uuid        NOT NULL,
  -- The outbox event it tells of: one delivery an event and subscription.
  event_id        uuid        NOT NULL,
  topic           text        NOT NULL,
  body            jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  -- The last try's HTTP status, or null when no answer came.
  response_status integer,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, subscription_id)
    REFERENCES apps.webhook_subscriptions (shop_id, id) ON DELETE CASCADE,
  UNIQUE (shop_id, subscription_id, event_id)
);
-- Across shops, for the worker: those due.
CREATE INDEX webhook_deliveries_due_idx ON apps.webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX webhook_deliveries_subscription_idx
  ON apps.webhook_deliveries (shop_id, subscription_id, created_at DESC);
CREATE INDEX webhook_deliveries_created_idx ON apps.webhook_deliveries (created_at);
SELECT platform.enable_tenant_isolation('apps.webhook_deliveries');
