-- 0283 · Comments waiting pushed to staff
-- Staff who write the shop's blogs may choose to be told on their phones when a shopper's
-- comment waits for their approval (ADR-619): a kind of push of its own. See ADR-619 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE messaging.push_subscriptions DROP CONSTRAINT push_subscriptions_kinds_check;
ALTER TABLE messaging.push_subscriptions ADD CONSTRAINT push_subscriptions_kinds_check
  CHECK (kinds <@ ARRAY['new_order', 'needs_review', 'cash_remitted', 'low_stock',
                        'contact_message', 'comment_pending']::text[]);
