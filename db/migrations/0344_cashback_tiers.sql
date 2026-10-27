-- 0344 · Cashback's tiers
-- Cashback (PAY-13, MKT-06) gives a larger share to customers who have spent more with the shop:
-- up to three tiers, each named, from what a customer has spent on their other orders, in minor
-- units, and the share it gives, in whole percent. Kept as the shop set them, by what they start
-- from. See ADR-806 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.automations
  ADD COLUMN cashback_tiers jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(cashback_tiers) = 'array' AND jsonb_array_length(cashback_tiers) <= 3),
  ADD CONSTRAINT automations_tiers_kind_check
    CHECK (kind = 'cashback' OR cashback_tiers = '[]');
