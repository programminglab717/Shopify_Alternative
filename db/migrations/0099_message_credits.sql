-- 0099 · Message credits
-- What a shop's messages are paid from (BIL-03, MSG-04): credit in rupees, bought from Hatti with
-- an invoice paid through Hatti's own gateway, as plans are, and spent as each message goes, at
-- what WhatsApp or the SMS gateway charges Hatti for it and Hatti's fee. Each change to the credit
-- is an entry, never changed after, with what the wallet held after it.
-- See ADR-155 in docs/architecture/13-decision-log.md.

-- An invoice may be for credits: no plan, nor period.
ALTER TABLE billing.invoices DROP CONSTRAINT invoices_reason_check;
ALTER TABLE billing.invoices
  ADD CONSTRAINT invoices_reason_check CHECK (reason IN ('change', 'renewal', 'credits'));
ALTER TABLE billing.invoices
  ALTER COLUMN plan DROP NOT NULL,
  ALTER COLUMN billing_interval DROP NOT NULL;
ALTER TABLE billing.invoices
  ADD CONSTRAINT invoices_credits_check
  CHECK ((reason = 'credits') = (plan IS NULL)
         AND (reason = 'credits') = (billing_interval IS NULL));

-- One invoice for a plan waits to be paid at a time, and one for credits.
DROP INDEX billing.invoices_open;
CREATE UNIQUE INDEX invoices_open ON billing.invoices (shop_id, (reason = 'credits'))
  WHERE status = 'open';

CREATE TABLE billing.wallets (
  shop_id    uuid        NOT NULL,
  -- Paisa: what the shop's messages are paid from. Below nothing only when messages sent at once
  -- took more than it held, which the next credit bought pays first.
  balance    bigint      NOT NULL DEFAULT 0,
  version    integer     NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id)
);

SELECT platform.enable_tenant_isolation('billing.wallets');

CREATE TABLE billing.wallet_entries (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- Credit bought, credit Hatti gave, a message paid for, or what one was charged given back.
  kind       text        NOT NULL
             CHECK (kind IN ('top_up', 'grant', 'message', 'message_refund')),
  -- Paisa: added, or taken for a message.
  amount     bigint      NOT NULL,
  -- Paisa: what the wallet held after it.
  balance    bigint      NOT NULL,
  -- The invoice whose payment bought it.
  invoice_id uuid,
  -- The message paid for, and how it was priced: its channel, its template's category, and its
  -- parts, an SMS being priced by the part.
  message_id uuid,
  channel    text        CHECK (channel IN ('whatsapp', 'sms')),
  category   text        CHECK (category IN ('utility', 'authentication', 'marketing')),
  parts      smallint    CHECK (parts BETWEEN 1 AND 20),
  -- Why Hatti gave it.
  note       text        CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, invoice_id) REFERENCES billing.invoices (shop_id, id),
  CHECK (CASE kind WHEN 'message' THEN amount < 0 ELSE amount > 0 END),
  CHECK ((kind = 'top_up') = (invoice_id IS NOT NULL)),
  CHECK ((kind IN ('message', 'message_refund')) = (message_id IS NOT NULL)),
  CHECK ((message_id IS NOT NULL) = (channel IS NOT NULL)
         AND (message_id IS NOT NULL) = (category IS NOT NULL)
         AND (message_id IS NOT NULL) = (parts IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('billing.wallet_entries');
REVOKE UPDATE, DELETE ON billing.wallet_entries FROM hatti_app_role;

-- Each message is paid for once, and given back once; each invoice tops up once.
CREATE UNIQUE INDEX wallet_entries_message ON billing.wallet_entries (shop_id, message_id, kind)
  WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX wallet_entries_invoice ON billing.wallet_entries (shop_id, invoice_id)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX wallet_entries_shop ON billing.wallet_entries (shop_id, created_at DESC, id DESC);
