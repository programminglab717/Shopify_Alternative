-- 0297 · A customer's refusal pushed before their next parcel ships
-- Staff who confirm orders may choose to be told on their phones when a customer refuses a
-- parcel while another of their orders, confirmed, waits to be packed or booked (ADR-672): a
-- kind of push of its own. See ADR-672 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.push_subscriptions DROP CONSTRAINT push_subscriptions_kinds_check;
ALTER TABLE messaging.push_subscriptions ADD CONSTRAINT push_subscriptions_kinds_check
  CHECK (kinds <@ ARRAY['new_order', 'needs_review', 'cash_remitted', 'low_stock',
                        'contact_message', 'comment_pending', 'orders_overdue',
                        'order_assigned', 'order_mentioned', 'customer_refused']::text[]);
