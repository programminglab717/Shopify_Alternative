-- 0064 · An advance of customers new to the shop, or by their risk
-- Cash on delivery's advance may be asked only of customers the shop has delivered nothing to
-- before, or only of orders its risk rules score at or above a threshold, as well as above a
-- total, to cities it names and of customers who refused parcels (CHK-10, COD-06). An order asked
-- it for its risk is asked instead of waiting for review. See ADR-094 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE checkout.cod_settings
  -- Only of customers none of whose orders the shop delivered before.
  ADD COLUMN advance_new_customers boolean NOT NULL DEFAULT false,
  -- Only of orders whose risk score, 1 to 100, is this or more; null for every order.
  ADD COLUMN advance_risk smallint CHECK (advance_risk BETWEEN 1 AND 100),
  DROP CONSTRAINT cod_settings_advance_rule_check,
  ADD CONSTRAINT cod_settings_advance_rule_check CHECK (
    (advance_kind IS NOT DISTINCT FROM 'fixed_amount') = (advance_amount IS NOT NULL)
    AND (advance_kind IS NOT DISTINCT FROM 'percentage') = (advance_bps IS NOT NULL)
    AND (advance_kind IS NOT NULL
         OR (advance_above IS NULL AND advance_cities = '{}' AND advance_refused IS NULL
             AND NOT advance_new_customers AND advance_risk IS NULL)));
