-- 0198 · Marketing automations
-- A shop's automations (MKT-04): recipes that send one of its own approved WhatsApp templates
-- (ADR-420) from its own number (ADR-419) when something happens to a customer who agreed to hear
-- from it there: a welcome once they subscribe, and a win-back some days after their last order.
-- One row per recipe the shop has set; a recipe never set is off.
-- See ADR-425 in docs/architecture/13-decision-log.md.

CREATE TABLE messaging.automations (
  shop_id      uuid        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('welcome', 'win_back')),
  enabled      boolean     NOT NULL DEFAULT false,
  -- The template it sends; one deleted since stops it sending until another is chosen.
  template_id  uuid,
  -- For a win-back: how many days after the customer's last order.
  after_days   integer     CHECK (after_days BETWEEN 14 AND 365),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, kind),
  CHECK (NOT enabled OR template_id IS NOT NULL),
  CHECK ((kind = 'win_back') = (after_days IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('messaging.automations');

-- The win-backs the worker sweeps: those turned on, whichever shop's.
CREATE INDEX automations_on ON messaging.automations (kind) WHERE enabled;

-- A customer's automation messages, to send each recipe once in its time.
CREATE INDEX messages_automation ON messaging.messages
  (shop_id, customer_id, (variables ->> 'automation'), created_at DESC)
  WHERE kind = 'automation';
