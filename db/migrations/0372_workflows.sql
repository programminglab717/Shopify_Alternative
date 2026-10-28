-- 0372 · Workflows (DEV-11)
-- A shop's own automations, as Shopify Flow's are: a trigger (an order placed, confirmed, paid,
-- cancelled, delivered or returned; a customer created; or a trigger an app offers), conditions
-- on the order, its customer or what the app sent, and actions done in turn (tags added or taken
-- away, staff told, or an action an app offers, posted to it signed). The owner and managers make
-- them; apps offer their triggers and actions, and fire their triggers, through the Admin API.
-- Each event makes one run of each workflow it triggers, kept 30 days. See ADR-861 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE apps.flow_extensions (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- The app offering it: its access token, as an install is one (ADR-851).
  token_id    uuid        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('trigger', 'action')),
  -- The app's own name for it, unique among its triggers or its actions: "review-posted".
  handle      text        NOT NULL CHECK (handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                                          AND char_length(handle) <= 50),
  title       text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  -- What it is about, whose ID the app sends with the trigger or is sent with the action.
  resource    text        NOT NULL CHECK (resource IN ('order', 'customer', 'none')),
  -- Where an action is posted; a trigger has none.
  url         text        CHECK (url ~ '^https://' AND char_length(url) <= 500),
  -- [{key, label, type, required}]: what the app sends with the trigger, or is sent.
  fields      jsonb       NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, token_id, kind, handle),
  CHECK ((kind = 'action') = (url IS NOT NULL)),
  FOREIGN KEY (shop_id, token_id) REFERENCES apps.access_tokens (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('apps.flow_extensions');

CREATE TABLE apps.workflows (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  trigger      text        NOT NULL CHECK (trigger IN ('order_created', 'order_confirmed',
                                                       'order_paid', 'order_cancelled',
                                                       'order_delivered', 'order_returned',
                                                       'customer_created', 'app')),
  -- An app's trigger; null for Hatti's own, and once the app takes it back or is removed.
  extension_id uuid,
  -- Whether all its conditions must hold, or any of them.
  match        text        NOT NULL DEFAULT 'all' CHECK (match IN ('all', 'any')),
  -- [{field, operator, value}], checked when it is saved.
  conditions   jsonb       NOT NULL DEFAULT '[]',
  -- [{type, ...}], done in turn.
  actions      jsonb       NOT NULL DEFAULT '[]',
  enabled      boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CHECK (trigger = 'app' OR extension_id IS NULL),
  FOREIGN KEY (shop_id, extension_id) REFERENCES apps.flow_extensions (shop_id, id)
    ON DELETE SET NULL (extension_id)
);

SELECT platform.enable_tenant_isolation('apps.workflows');

CREATE INDEX workflows_triggered ON apps.workflows (shop_id, trigger) WHERE enabled;

CREATE TABLE apps.workflow_runs (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT platform.uuidv7(),
  workflow_id     uuid        NOT NULL,
  -- The event that triggered it: each triggers a workflow once, however often it is heard.
  event_id        uuid        NOT NULL,
  -- {orderId, customerId, properties}: what it is about.
  subject         jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  -- Whether its conditions held, once checked: they are checked once, at its first try.
  conditions_met  boolean,
  -- [{action, outcome, detail}]: how each action went, in turn.
  steps           jsonb       NOT NULL DEFAULT '[]',
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, workflow_id, event_id),
  FOREIGN KEY (shop_id, workflow_id) REFERENCES apps.workflows (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('apps.workflow_runs');

CREATE INDEX workflow_runs_due ON apps.workflow_runs (next_attempt_at) WHERE status = 'pending';
CREATE INDEX workflow_runs_latest ON apps.workflow_runs (shop_id, workflow_id, created_at DESC);
CREATE INDEX workflow_runs_kept ON apps.workflow_runs (created_at);

-- Staff told by a workflow (ADR-861): a kind of push of its own.
ALTER TABLE messaging.push_subscriptions DROP CONSTRAINT push_subscriptions_kinds_check;
ALTER TABLE messaging.push_subscriptions ADD CONSTRAINT push_subscriptions_kinds_check
  CHECK (kinds <@ ARRAY['new_order', 'needs_review', 'cash_remitted', 'low_stock',
                        'contact_message', 'comment_pending', 'orders_overdue',
                        'order_assigned', 'order_mentioned', 'customer_refused',
                        'conversation_message', 'conversation_assigned',
                        'conversation_overdue', 'workflow_alert']::text[]);
