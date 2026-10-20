-- 0284 · Orders overdue for their first call pushed to staff
-- Staff who confirm orders may choose to be told on their phones when orders have waited for
-- their first call longer than the shop's target (ADR-627): a kind of push of its own. See
-- ADR-627 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.push_subscriptions DROP CONSTRAINT push_subscriptions_kinds_check;
ALTER TABLE messaging.push_subscriptions ADD CONSTRAINT push_subscriptions_kinds_check
  CHECK (kinds <@ ARRAY['new_order', 'needs_review', 'cash_remitted', 'low_stock',
                        'contact_message', 'comment_pending', 'orders_overdue']::text[]);
