-- 0264 · FBR's digital invoicing
-- A seller registered for sales tax reports each invoice it issues through FBR's digital
-- invoicing (TAX-04), as a Tier-1 retailer's POS reports to FBR's IMS: the shop's connection to
-- FBR says which of the two it reports through, and only a POS has a POS ID. Each invoice kept
-- says which it was kept for, as each takes it in its own shape, so one kept for the one is never
-- sent to the other. See ADR-562 in docs/architecture/13-decision-log.md.

ALTER TABLE tax.fbr_pos
  -- FBR's IMS, from a Tier-1 retailer's POS, or its digital invoicing.
  ADD COLUMN system text NOT NULL DEFAULT 'pos' CHECK (system IN ('pos', 'digital_invoicing')),
  ALTER COLUMN pos_id DROP NOT NULL,
  ADD CONSTRAINT fbr_pos_pos_id_of_pos CHECK ((pos_id IS NOT NULL) = (system = 'pos'));

ALTER TABLE tax.fiscal_invoices
  -- Which of the two it was kept for, and its payload is in the shape of.
  ADD COLUMN system text NOT NULL DEFAULT 'pos' CHECK (system IN ('pos', 'digital_invoicing'));
