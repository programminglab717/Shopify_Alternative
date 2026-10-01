-- 0068 · Prepaid alone for the riskiest orders
-- Checkout doesn't take an order paid on delivery that the shop's risk rules score at a limit of
-- its own or above (COD-06): placed and scored as any such order, it is undone, and the page asks
-- for a bank transfer instead, or says the shop can't take it paid on delivery. The limit is
-- above the risk an advance is asked from, where the shop asks one by risk. See ADR-099 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE checkout.cod_settings
  -- Orders whose risk score, 1 to 100, is this or more are paid another way; null for no limit.
  ADD COLUMN risk_limit smallint CHECK (risk_limit BETWEEN 1 AND 100),
  ADD CONSTRAINT cod_settings_risk_above_advance_check
    CHECK (risk_limit IS NULL OR advance_risk IS NULL OR risk_limit > advance_risk);
