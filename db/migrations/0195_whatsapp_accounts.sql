-- 0195 · A shop's own WhatsApp number
-- A shop connects its own WhatsApp Business Account through Meta's Embedded Signup, Hatti being
-- the Tech Provider (ADR-012): the account, its number in WhatsApp's Cloud API, the name Meta
-- verified, and the token Meta gave for them, sealed for the shop alone, with the PIN the number
-- was registered with. Broadcasts and the shop's own templates go from it (MKT-01); a number is
-- one shop's at a time.
-- See ADR-419 in docs/architecture/13-decision-log.md.

CREATE TABLE messaging.whatsapp_accounts (
  shop_id              uuid        PRIMARY KEY,
  business_account_id  text        NOT NULL CHECK (business_account_id ~ '^[0-9]{1,30}$'),
  phone_number_id      text        NOT NULL CHECK (phone_number_id ~ '^[0-9]{1,30}$'),
  -- As Meta shows it: "+92 300 1234567".
  display_phone_number text        NOT NULL CHECK (char_length(display_phone_number) <= 30),
  verified_name        text        NOT NULL CHECK (char_length(verified_name) <= 200),
  quality_rating       text        NOT NULL DEFAULT 'unknown'
                                   CHECK (quality_rating IN ('green', 'yellow', 'red', 'unknown')),
  -- Sealed with the shop's ID: the business token Embedded Signup's code was exchanged for.
  access_token         text        NOT NULL,
  -- Sealed likewise: the two-step verification PIN Hatti registered the number with.
  pin                  text        NOT NULL,
  version              integer     NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('messaging.whatsapp_accounts');

-- A number sends for one shop at a time: another shop connecting it is refused.
CREATE UNIQUE INDEX whatsapp_accounts_number ON messaging.whatsapp_accounts (phone_number_id);
