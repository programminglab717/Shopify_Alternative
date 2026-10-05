-- 0122 · Sign-ups on the storefront (CUS-04)
-- A shopper's mobile number given in the online store's sign-up form, which Shopify's themes post
-- as their customer form, is the customer's consent to the shop's news and offers on WhatsApp:
-- the consent ledger names the storefront as where it was given.
-- See ADR-189 in docs/architecture/13-decision-log.md.

ALTER TABLE customers.consent_events
  DROP CONSTRAINT consent_events_source_check,
  ADD CONSTRAINT consent_events_source_check
    CHECK (source IN ('manual', 'api', 'import', 'checkout', 'reply', 'contact_changed',
                      'storefront'));
