-- 0252 · Hatti's order templates on a shop's own number
-- Hatti's library of utility templates, the news of an order its customer placed (07 §2.2), sent
-- to Meta for approval on the WhatsApp Business Account a shop connected (ADR-419), each kept
-- with the shop's own templates under the name it has on Hatti's number and the kind of message
-- it carries. Once Meta approves one, that kind goes from the shop's own number. An account is
-- sent the library at most once a day, until it has all of it.
-- See ADR-537 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.whatsapp_templates
  ADD COLUMN library_kind text CHECK (library_kind ~ '^[a-z_]{1,60}$');

CREATE UNIQUE INDEX whatsapp_templates_library
  ON messaging.whatsapp_templates (shop_id, business_account_id, library_kind, language)
  WHERE library_kind IS NOT NULL;

-- When the worker last sent the account the library: none since it was connected, if null.
ALTER TABLE messaging.whatsapp_accounts ADD COLUMN library_tried_at timestamptz;
