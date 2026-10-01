-- 0065 · Sales tax, included in prices
-- A shop's sales tax (TAX-01, CHK-17): the rate included in the prices of what it sells, as
-- Pakistan's consumer laws ask prices to be shown, and in its delivery charges if it says so. The
-- tax module keeps the rate; Shopify's variants say whether they are taxed; each order keeps the
-- tax included in it as it was placed, by line and in delivery, for its receipts and invoices.
-- See ADR-096 in docs/architecture/13-decision-log.md.

CREATE SCHEMA tax;

GRANT USAGE ON SCHEMA tax TO hatti_app_role, hatti_system_role;

CREATE TABLE tax.settings (
  shop_id      uuid        PRIMARY KEY,
  -- Hundredths of a percent included in its prices: 1800 is 18%. Null: it charges none.
  rate         integer     CHECK (rate BETWEEN 1 AND 5000),
  -- Whether delivery charges, and the fee for paying on delivery, include it too.
  tax_delivery boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('tax.settings');

-- Shopify's "Charge tax on this variant".
ALTER TABLE catalog.variants ADD COLUMN taxable boolean NOT NULL DEFAULT true;

-- What of each line's total, after its share of the order's discount, was tax, and at what rate;
-- orders placed before have none.
ALTER TABLE orders.lines
  ADD COLUMN taxable  boolean NOT NULL DEFAULT true,
  ADD COLUMN tax_rate integer CHECK (tax_rate BETWEEN 1 AND 5000),
  ADD COLUMN tax      bigint  NOT NULL DEFAULT 0,
  ADD CONSTRAINT lines_tax_check CHECK (
    tax BETWEEN 0 AND total
    AND (tax_rate IS NOT NULL OR tax = 0)
    AND (taxable OR tax_rate IS NULL));

-- The shop's rate when the order was placed, the tax in all of it, and of that, the tax in its
-- delivery charge and its fee for paying on delivery.
ALTER TABLE orders.orders
  ADD COLUMN tax_rate     integer CHECK (tax_rate BETWEEN 1 AND 5000),
  ADD COLUMN total_tax    bigint  NOT NULL DEFAULT 0,
  ADD COLUMN shipping_tax bigint  NOT NULL DEFAULT 0,
  ADD CONSTRAINT orders_tax_check CHECK (
    shipping_tax BETWEEN 0 AND total_tax
    AND shipping_tax <= shipping + cod_fee
    AND total_tax <= total
    AND (tax_rate IS NOT NULL OR total_tax = 0));
