-- 0014 · Audit log
-- Who did what, for the shop's activity log: reads and changes the shop may need to account for,
-- such as revealing a customer's number to staff who see it masked, exporting customers, merging
-- or erasing them, and changing policies. Append-only for request code. See
-- docs/engineering/conventions.md.
CREATE TABLE platform.audit_log (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL,
  -- "subject.verb", e.g. "customer.phone_revealed".
  action       text        NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  -- What it was done to, as a kind of public ID ("customer", "order", "shop").
  subject_type text        NOT NULL CHECK (subject_type ~ '^[a-zA-Z]+$'),
  subject_id   uuid        NOT NULL,
  actor_kind   text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  -- The access token or the staff member.
  actor_id     uuid        NOT NULL,
  -- The staff member's role at the time; null for apps.
  actor_role   text,
  -- More about it. Never contact details.
  details      jsonb       NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

-- Everything about one customer or order, newest first.
CREATE INDEX audit_log_subject_idx ON platform.audit_log (shop_id, subject_id, id DESC);

SELECT platform.enable_tenant_isolation('platform.audit_log');
REVOKE UPDATE, DELETE ON platform.audit_log FROM hatti_app_role;
