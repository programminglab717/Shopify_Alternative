-- 0059 · An advance by city or customer
-- Cash on delivery's advance may be asked for only on orders to cities the shop names, or only of
-- customers who refused parcels before, as well as only above a total (CHK-10). Checkout says
-- so beside the option, and placing the order applies them to the city and number typed. See
-- ADR-089 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.cod_settings
  -- Cities as addresses name them, which checkout's page names all; empty for everywhere.
  ADD COLUMN advance_cities text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(advance_cities) <= 50),
  -- Only of customers who refused this many parcels before, or more; null for every customer.
  ADD COLUMN advance_refused smallint CHECK (advance_refused BETWEEN 1 AND 100),
  DROP CONSTRAINT cod_settings_advance_rule_check,
  ADD CONSTRAINT cod_settings_advance_rule_check CHECK (
    (advance_kind IS NOT DISTINCT FROM 'fixed_amount') = (advance_amount IS NOT NULL)
    AND (advance_kind IS NOT DISTINCT FROM 'percentage') = (advance_bps IS NOT NULL)
    AND (advance_kind IS NOT NULL
         OR (advance_above IS NULL AND advance_cities = '{}' AND advance_refused IS NULL)));
