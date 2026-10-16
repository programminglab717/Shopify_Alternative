-- 0201 · COD to prepaid
-- A recipe of the shop's automations (MKT-04): once a cash-on-delivery order is confirmed, its
-- customer is offered store credit, an amount the shop sets, for paying the rest of it online
-- before it ships, on WhatsApp from Hatti's shared number with the order's link, as back in stock
-- is sent (ADR-429). The order keeps the credit offered, and when it was given, once it was paid
-- in full online.
-- See ADR-432 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.automations
  -- For COD to prepaid: the store credit offered, in minor units, Rs 10 to Rs 10,000.
  ADD COLUMN credit_amount bigint CHECK (credit_amount BETWEEN 1000 AND 1000000),
  DROP CONSTRAINT automations_kind_check,
  ADD CONSTRAINT automations_kind_check
    CHECK (kind IN ('welcome', 'win_back', 'back_in_stock', 'cod_prepaid')),
  -- Back in stock and COD to prepaid send Hatti's own templates; the others the shop's, chosen
  -- before they are on.
  DROP CONSTRAINT automations_template_check,
  ADD CONSTRAINT automations_template_check
    CHECK (CASE WHEN kind IN ('back_in_stock', 'cod_prepaid') THEN template_id IS NULL
                ELSE NOT enabled OR template_id IS NOT NULL END),
  ADD CONSTRAINT automations_credit_check
    CHECK ((kind = 'cod_prepaid') = (credit_amount IS NOT NULL));

ALTER TABLE orders.orders
  -- The store credit its customer was offered for paying the rest online, in minor units.
  ADD COLUMN prepay_credit bigint CHECK (prepay_credit > 0),
  -- When it was given, the order paid in full online.
  ADD COLUMN prepay_credited_at timestamptz,
  ADD CONSTRAINT orders_prepay_check
    CHECK (prepay_credited_at IS NULL OR prepay_credit IS NOT NULL);
