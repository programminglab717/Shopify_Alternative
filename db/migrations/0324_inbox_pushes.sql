-- 0324 · The inbox pushed to staff's phones
-- Staff who answer customers may choose to be told on their phones when a customer starts
-- waiting on WhatsApp, and when a conversation is given to them by another (MSG-06, ADR-761):
-- two kinds of push of their own. See ADR-761 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.push_subscriptions DROP CONSTRAINT push_subscriptions_kinds_check;
ALTER TABLE messaging.push_subscriptions ADD CONSTRAINT push_subscriptions_kinds_check
  CHECK (kinds <@ ARRAY['new_order', 'needs_review', 'cash_remitted', 'low_stock',
                        'contact_message', 'comment_pending', 'orders_overdue',
                        'order_assigned', 'order_mentioned', 'customer_refused',
                        'conversation_message', 'conversation_assigned']::text[]);
