-- 0261 · FBR's POS integration
-- A Tier-1 retailer reports each invoice it issues to FBR as it issues it (POS-04, TAX-04): the
-- shop connects the POS ID FBR registered for it with FBR's access token, and each invoice and
-- credit note it issues from then on is kept here as FBR is sent it, until FBR gives it its own
-- invoice number. See ADR-555 in docs/architecture/13-decision-log.md.

-- The shop's POS as FBR registered it, and the access token FBR gave for it.
CREATE TABLE tax.fbr_pos (
  shop_id      uuid        PRIMARY KEY,
  -- The POS ID FBR gave the shop's POS when it registered it.
  pos_id       bigint      NOT NULL CHECK (pos_id > 0 AND pos_id < 10000000000),
  -- Sealed for the shop alone, and never shown again.
  access_token text        NOT NULL,
  -- Its last four characters, to tell tokens apart by.
  token_hint   text        NOT NULL CHECK (char_length(token_hint) = 4),
  -- FBR's sandbox, to try it, or the real one.
  environment  text        NOT NULL CHECK (environment IN ('sandbox', 'production')),
  -- The PCT code each item is reported under, 8 digits, until variants have codes of their own.
  pct_code     text        NOT NULL CHECK (pct_code ~ '^[0-9]{8}$'),
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('tax.fbr_pos');

-- Each invoice and credit note the shop issued while connected, as FBR is sent it.
CREATE TABLE tax.fiscal_invoices (
  shop_id            uuid        NOT NULL,
  id                 uuid        NOT NULL,
  kind               text        NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  -- The shop's own number for it, FBR's USIN: "INV/2026-27/00001" or "CN/2026-27/00001".
  usin               text        NOT NULL CHECK (char_length(usin) BETWEEN 1 AND 50),
  order_id           uuid        NOT NULL,
  -- What FBR is sent, but the POS ID and items' PCT code, the shop's as it reports it.
  payload            jsonb       NOT NULL,
  status             text        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'reported', 'failed', 'skipped')),
  -- The number FBR gave it, once reported.
  fbr_invoice_number text        CHECK (char_length(fbr_invoice_number) <= 100),
  attempts           integer     NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  error              text        CHECK (char_length(error) <= 1000),
  reported_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, usin),
  CHECK ((status = 'reported') = (fbr_invoice_number IS NOT NULL AND reported_at IS NOT NULL))
);

CREATE INDEX fiscal_invoices_due ON tax.fiscal_invoices (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX fiscal_invoices_order ON tax.fiscal_invoices (shop_id, order_id);
CREATE INDEX fiscal_invoices_latest ON tax.fiscal_invoices (shop_id, created_at DESC, id DESC);

SELECT platform.enable_tenant_isolation('tax.fiscal_invoices');
