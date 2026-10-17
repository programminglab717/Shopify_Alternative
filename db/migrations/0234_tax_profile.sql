-- 0234 · The shop's tax profile (ONB-12, TAX-02)
-- Beside the numbers FBR registered the shop under: the province its business is registered in,
-- whether it is on FBR's Active Taxpayers List, which halves the income tax couriers and payment
-- gateways withhold from it, and whether it is a Tier-1 retailer, for whom the 2% sales tax they
-- collect is an advance rather than the whole of it. The admin guides the shop by them. See
-- ADR-500 in docs/architecture/13-decision-log.md.

ALTER TABLE tax.settings
  ADD COLUMN province     text CHECK (province IN ('punjab', 'sindh', 'khyber_pakhtunkhwa',
                                                   'balochistan', 'islamabad', 'gilgit_baltistan',
                                                   'azad_kashmir')),
  ADD COLUMN filer_status text NOT NULL DEFAULT 'unknown'
                          CHECK (filer_status IN ('active', 'inactive', 'unknown')),
  ADD COLUMN tier1        boolean NOT NULL DEFAULT false;
