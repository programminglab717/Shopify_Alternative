-- 0286 · Orders given to staff, and comments naming them, pushed
-- A member of staff may choose to be told on their phone of an order given to them and of a
-- comment on an order that names them (ADR-633), as they are on WhatsApp: two kinds of push of
-- their own. See ADR-633 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.push_subscriptions DROP CONSTRAINT push_subscriptions_kinds_check;
ALTER TABLE messaging.push_subscriptions ADD CONSTRAINT push_subscriptions_kinds_check
  CHECK (kinds <@ ARRAY['new_order', 'needs_review', 'cash_remitted', 'low_stock',
                        'contact_message', 'comment_pending', 'orders_overdue',
                        'order_assigned', 'order_mentioned']::text[]);
