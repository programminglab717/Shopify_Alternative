-- 0210 · Cashback
-- A recipe of the shop's automations (PAY-13, MKT-04): once an order is delivered and paid in
-- full, its customer is given a share of what its goods came to in store credit, which checkout
-- spends (ADR-186) and WhatsApp tells them of (ADR-192), expiring some days on.
-- See ADR-453 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.automations
  -- For cashback: the share of an order's goods given back, in whole percent, 1 to 20.
  ADD COLUMN cashback_percent smallint CHECK (cashback_percent BETWEEN 1 AND 20),
  -- For cashback: how many days the credit lasts, 7 to 365; null: it never expires.
  ADD COLUMN credit_days smallint CHECK (credit_days BETWEEN 7 AND 365),
  DROP CONSTRAINT automations_kind_check,
  ADD CONSTRAINT automations_kind_check
    CHECK (kind IN ('welcome', 'win_back', 'back_in_stock', 'cod_prepaid', 'cashback')),
  -- Back in stock, COD to prepaid and cashback send Hatti's own messages; the others the shop's
  -- templates, chosen before they are on.
  DROP CONSTRAINT automations_template_check,
  ADD CONSTRAINT automations_template_check
    CHECK (CASE WHEN kind IN ('back_in_stock', 'cod_prepaid', 'cashback')
                THEN template_id IS NULL
                ELSE NOT enabled OR template_id IS NOT NULL END),
  ADD CONSTRAINT automations_cashback_check
    CHECK ((kind = 'cashback') = (cashback_percent IS NOT NULL)
           AND (kind = 'cashback' OR credit_days IS NULL));
