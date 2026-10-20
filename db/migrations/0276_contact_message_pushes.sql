-- 0276 · Contact form messages pushed to staff
-- Staff who answer customers may choose to be told on their phones when a shopper writes through
-- the online store's contact form (ADR-591): a kind of push of its own. See ADR-591 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE messaging.push_subscriptions DROP CONSTRAINT push_subscriptions_kinds_check;
ALTER TABLE messaging.push_subscriptions ADD CONSTRAINT push_subscriptions_kinds_check
  CHECK (kinds <@ ARRAY['new_order', 'needs_review', 'cash_remitted', 'low_stock',
                        'contact_message']::text[]);
