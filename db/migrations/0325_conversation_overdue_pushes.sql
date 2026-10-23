-- 0325 · Conversations waiting too long pushed
-- Staff who answer customers may choose to be told on their phones when a customer has waited
-- past the shop's time to answer (MSG-06, ADR-762): a kind of push of its own.
-- See ADR-762 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.push_subscriptions DROP CONSTRAINT push_subscriptions_kinds_check;
ALTER TABLE messaging.push_subscriptions ADD CONSTRAINT push_subscriptions_kinds_check
  CHECK (kinds <@ ARRAY['new_order', 'needs_review', 'cash_remitted', 'low_stock',
                        'contact_message', 'comment_pending', 'orders_overdue',
                        'order_assigned', 'order_mentioned', 'customer_refused',
                        'conversation_message', 'conversation_assigned',
                        'conversation_overdue']::text[]);
