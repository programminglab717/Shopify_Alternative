-- 0054 · Checkout asking for an advance
-- The shop's rules for cash on delivery may ask for an advance (CHK-10): an amount, a percentage
-- of the items or the delivery charge, on every order or on those whose items come to more than a
-- total. Checkout says it beside the option, and the order it places waits for it, paid by
-- transfer into the shop's account. See ADR-084 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.cod_settings
  -- What it asks for; null for no advance.
  ADD COLUMN advance_kind text CHECK (advance_kind IN ('fixed_amount', 'percentage', 'delivery')),
  -- Minor units, for an amount.
  ADD COLUMN advance_amount bigint CHECK (advance_amount > 0),
  -- Hundredths of a percent of the items after any code, for a percentage: 2000 is 20%.
  ADD COLUMN advance_bps integer CHECK (advance_bps BETWEEN 1 AND 10000),
  -- Minor units: only orders whose items come to more; null for every order.
  ADD COLUMN advance_above bigint CHECK (advance_above > 0),
  ADD CONSTRAINT cod_settings_advance_rule_check CHECK (
    (advance_kind IS NOT DISTINCT FROM 'fixed_amount') = (advance_amount IS NOT NULL)
    AND (advance_kind IS NOT DISTINCT FROM 'percentage') = (advance_bps IS NOT NULL)
    AND (advance_kind IS NOT NULL OR advance_above IS NULL));
