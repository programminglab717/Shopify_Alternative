-- 0066 · Tax categories
-- Rates of their own for some products (TAX-01): the shop's tax categories, each a code, a name
-- and a rate, which variants name by Shopify's tax code. A taxable variant whose code is one of
-- them is taxed at its rate, any other at the shop's. See ADR-097 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE tax.settings
  -- [{"code": "REDUCED", "name": "Reduced rate", "rate": 1000}], in the shop's order; at most 20.
  ADD COLUMN categories jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(categories) = 'array' AND jsonb_array_length(categories) <= 20);

-- Shopify's "Variant Tax Code": the category its price's tax is at, matched in any letter case.
ALTER TABLE catalog.variants
  ADD COLUMN tax_code text CHECK (tax_code ~ '^[A-Za-z0-9._-]{1,40}$');
