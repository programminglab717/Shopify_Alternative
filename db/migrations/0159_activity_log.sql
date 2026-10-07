-- 0159 · The shop's activity log
-- What the shop's staff and apps changed (ADM-04): each event a request of the Admin API appends
-- is kept here too, with who made it, a member of staff with their role then or an app by its
-- access token, and what it happened to; never what the event recorded. Apart from the outbox,
-- whose events last days, so that it is kept as long as the audit log. Append-only for request
-- code. See ADR-256 in docs/architecture/13-decision-log.md.
CREATE TABLE platform.activity_log (
  shop_id        uuid        NOT NULL,
  -- The event's.
  id             uuid        NOT NULL,
  -- As the event names it: "product.updated".
  event_type     text        NOT NULL,
  -- What it happened to, as the event names it: "product", "tax_settings".
  aggregate_type text        NOT NULL,
  aggregate_id   uuid        NOT NULL,
  actor_kind     text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  -- The member of staff, or the app's access token.
  actor_id       uuid        NOT NULL,
  -- A member of staff's role at the time; null for an app.
  actor_role     text        CHECK (char_length(actor_role) <= 40),
  occurred_at    timestamptz NOT NULL,
  PRIMARY KEY (shop_id, id),
  CONSTRAINT activity_log_role_check CHECK (actor_kind = 'staff' OR actor_role IS NULL)
);

-- Everything that happened to one thing, the latest first.
CREATE INDEX activity_log_subject_idx ON platform.activity_log (shop_id, aggregate_id, id DESC);

SELECT platform.enable_tenant_isolation('platform.activity_log');
REVOKE UPDATE, DELETE ON platform.activity_log FROM hatti_app_role;
