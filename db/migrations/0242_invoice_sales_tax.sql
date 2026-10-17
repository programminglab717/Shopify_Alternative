-- 0242 · Sales tax on Hatti's invoices
-- Hatti's plans and credit are priced exclusive of provincial sales tax on services (BIL-02,
-- docs/product/03). Where Hatti is registered with a province's revenue authority, each invoice
-- carries that tax at the authority's rate, with the authority and Hatti's registration number as
-- they were when it was made; what the shop pays is the price, less any credit, and the tax.
-- Without a registration, invoices carry none, as before.
-- See ADR-512 in docs/architecture/13-decision-log.md.

ALTER TABLE billing.invoices
  ADD COLUMN tax              bigint NOT NULL DEFAULT 0 CHECK (tax >= 0),
  -- Basis points: 1600 for 16%.
  ADD COLUMN tax_rate         integer NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 5000),
  ADD COLUMN tax_authority    text CHECK (tax_authority IN ('PRA', 'SRB', 'KPRA', 'BRA', 'ICT')),
  ADD COLUMN tax_registration text CHECK (char_length(tax_registration) BETWEEN 1 AND 40),
  ADD CONSTRAINT invoices_tax_registered
    CHECK ((tax_authority IS NULL) = (tax_registration IS NULL)
           AND (tax_authority IS NOT NULL OR (tax = 0 AND tax_rate = 0)));

-- What the shop pays: the price, less any credit, and the tax.
ALTER TABLE billing.invoices DROP COLUMN amount;
ALTER TABLE billing.invoices
  ADD COLUMN amount bigint GENERATED ALWAYS AS (price - credit + tax) STORED;
