-- 0259 · A consent banner
-- A shop may ask its shoppers before its ad platforms' pixels load (MKT-10): its storefront shows
-- a banner until the shopper accepts or declines, the pixels waiting for the answer, and an order
-- placed by one who declined goes to no ad platform. See ADR-551 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  ADD COLUMN consent_banner boolean NOT NULL DEFAULT false;
