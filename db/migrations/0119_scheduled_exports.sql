-- 0119 · Scheduled exports
-- Exports of a shop's orders a member of staff schedules (ORD-11): every day, week or month, the
-- orders placed in the one that just ended, as CSV or an Excel workbook, emailed to the member as
-- an attachment. Each schedule names its member by their account; whom it goes to is found as it
-- is sent, so that one who left the shop, or may no longer export, gets nothing.
-- See ADR-183 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.export_schedules (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL,
  -- The member of staff it goes to, by their account's ID.
  user_id     uuid        NOT NULL,
  frequency   text        NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  -- The hour of the day it goes, in the shop's time zone, once its period has ended.
  hour        smallint    NOT NULL CHECK (hour BETWEEN 0 AND 23),
  layout      text        NOT NULL CHECK (layout IN ('orders', 'line_items')),
  format      text        NOT NULL CHECK (format IN ('csv', 'xlsx')),
  -- As orders(query:) takes it; empty for every order.
  query       text        NOT NULL DEFAULT '' CHECK (length(query) <= 1000),
  -- The day the period it sends next ends on, in the shop's time zone: the orders placed before
  -- it, from a day, a week or a month earlier.
  period_end  date        NOT NULL,
  -- When it next tries to send: `hour` on period_end, or later, once a try failed.
  next_run_at timestamptz NOT NULL,
  -- Tries at the period it sends next.
  attempts    integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_sent_at timestamptz,
  -- Why the last period went unsent, or its last try failed.
  last_error  text        CHECK (length(last_error) <= 1000),
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.export_schedules');

-- The worker finds those due across shops.
CREATE INDEX export_schedules_due ON orders.export_schedules (next_run_at);

-- Whom a scheduled export goes to: the email of account `p_user_id`, active and proved, and not
-- suppressed for bounces or complaints, while it works in shop `p_shop_id`, active, with its role
-- there. No row otherwise. Only for the shop of the transaction asking, and SECURITY DEFINER, so
-- that the worker, which never reads identity's tables, learns no more than this.
CREATE FUNCTION identity.staff_email(p_user_id uuid, p_shop_id uuid)
  RETURNS TABLE (email text, name text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.email, u.name, m.role
    FROM identity.users u
    JOIN identity.memberships m
      ON m.user_id = u.id AND m.shop_id = p_shop_id AND m.status = 'active'
    JOIN control.shops sh ON sh.id = m.shop_id AND sh.status = 'active'
   WHERE u.id = p_user_id
     AND u.status = 'active'
     AND u.email IS NOT NULL
     AND u.email_verified_at IS NOT NULL
     AND p_shop_id = platform.current_shop_id()
     AND NOT EXISTS (SELECT 1 FROM identity.email_suppressions s WHERE s.email = u.email)
$$;

ALTER FUNCTION identity.staff_email(uuid, uuid) OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.staff_email(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.staff_email(uuid, uuid) TO hatti_app_role;
